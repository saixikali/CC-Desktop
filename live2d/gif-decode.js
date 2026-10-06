/* 极简 GIF 解码器（零依赖，全局 GifReader）
 * 背景：部分 Windows 环境（系统"关闭动画"/RDP）会让 Chromium 冻结 <img> 的 GIF 动画，
 * 且 canvas drawImage 只能拿到首帧。桌宠需要自己解码并按帧延迟播放。
 * 输出：renderFrames() → [{ data: Uint8ClampedArray RGBA, delay: ms }]，已处理隔行/透明/处置方式。
 */
(function (global) {
  "use strict";

  function lzwDecode(minCodeSize, data) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let dict = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < clearCode; i++) dict.push([i]);
      dict.push(null, null); // CLEAR / EOI 占位
      codeSize = minCodeSize + 1;
    };
    let bitPos = 0;
    const totalBits = data.length * 8;
    const readCode = () => {
      let v = 0;
      for (let i = 0; i < codeSize; i++) {
        const bi = bitPos++;
        if (bi >= totalBits) break;
        if ((data[bi >> 3] >> (bi & 7)) & 1) v |= 1 << i;
      }
      return v;
    };
    reset();
    const out = [];
    let prev = null;
    while (bitPos < totalBits - codeSize) {
      const code = readCode();
      if (code === clearCode) { reset(); prev = null; continue; }
      if (code === eoiCode) break;
      let entry;
      if (code < dict.length) entry = dict[code];
      else if (code === dict.length && prev) entry = prev.concat(prev[0]);
      else break;
      if (entry) {
        for (let i = 0; i < entry.length; i++) out.push(entry[i]);
        if (prev) dict.push(prev.concat(entry[0]));
        prev = entry;
      }
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    return out;
  }

  class GifReader {
    constructor(buffer) {
      this.b = new Uint8Array(buffer);
      this.p = 0;
      this.frames = [];
      this._parse();
    }
    _u8() { return this.b[this.p++]; }
    _u16() { return this.b[this.p++] | (this.b[this.p++] << 8); }
    _bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
    _colorTable(n) {
      const t = new Uint8Array(n * 3);
      t.set(this._bytes(n * 3));
      return t;
    }
    _subblocks() {
      const parts = [];
      let total = 0;
      for (;;) {
        const n = this._u8();
        if (n === 0) break;
        parts.push(this._bytes(n));
        total += n;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const part of parts) { out.set(part, off); off += part.length; }
      return out;
    }
    _parse() {
      const sig = String.fromCharCode(...this._bytes(6));
      if (!/^GIF8[79]a/.test(sig)) throw new Error("not a gif");
      this.width = this._u16();
      this.height = this._u16();
      const packed = this._u8();
      this.bgIndex = this._u8();
      this._u8(); // pixel aspect
      let gct = null;
      if (packed & 0x80) {
        const n = 2 << ((packed >> 0) & 0x07);
        gct = this._colorTable(n);
      }
      let pending = { delay: 100, dispose: 0, transIndex: -1 };
      for (;;) {
        const id = this._u8();
        if (id === 0x3B) break; // trailer
        if (id === 0x21) { // extension
          const label = this._u8();
          if (label === 0xF9) { // graphic control
            this._u8(); // block size = 4
            const f = this._u8();
            const delay = this._u16() * 10;
            const trans = this._u8();
            this._u8(); // terminator
            pending = { delay: delay || 100, dispose: (f >> 2) & 0x07, transIndex: (f & 1) ? trans : -1 };
          } else {
            this._subblocks(); // 跳过应用扩展/注释等
          }
        } else if (id === 0x2C) { // image descriptor
          const gx = this._u16(), gy = this._u16(), w = this._u16(), h = this._u16();
          const ip = this._u8();
          let lct = null;
          if (ip & 0x80) {
            const n = 2 << (ip & 0x07);
            lct = this._colorTable(n);
          }
          const minCode = this._u8();
          const lzw = this._subblocks();
          let indices = lzwDecode(minCode, lzw);
          if (indices.length < w * h) indices = indices.concat(new Array(w * h - indices.length).fill(0));
          this.frames.push({
            gx, gy, w, h,
            interlace: !!(ip & 0x40),
            ct: lct || gct,
            transIndex: pending.transIndex,
            dispose: pending.dispose,
            delay: pending.delay,
            indices: indices.subarray ? indices.subarray(0, w * h) : new Uint8Array(indices.slice(0, w * h))
          });
          pending = { delay: 100, dispose: 0, transIndex: -1 };
        } else {
          break;
        }
      }
      if (this.frames.length === 0) throw new Error("gif has no frames");
    }
    // 逐帧合成（处置方式 0/1 保留，2 清透明，3 还原前态），返回 RGBA 帧序列
    renderFrames() {
      const W = this.width, H = this.height;
      const buf = new Uint8ClampedArray(W * H * 4);
      const outputs = [];
      let saved = null;
      let prevDispose = 0, prevRect = null;
      for (const f of this.frames) {
        if (prevDispose === 2 && prevRect) {
          for (let y = 0; y < prevRect.h; y++) {
            const row = ((prevRect.gy + y) * W + prevRect.gx) * 4;
            buf.fill(0, row, row + prevRect.w * 4);
          }
        } else if (prevDispose === 3 && saved) {
          buf.set(saved);
        }
        if (f.dispose === 3) saved = buf.slice();
        // 隔行扫描的标准 4 趟行序：0,8,… → 4,12,… → 2,6,… → 1,3,…
        const rows = [];
        if (f.interlace) {
          for (let y = 0; y < f.h; y += 8) rows.push(y);
          for (let y = 4; y < f.h; y += 8) rows.push(y);
          for (let y = 2; y < f.h; y += 4) rows.push(y);
          for (let y = 1; y < f.h; y += 2) rows.push(y);
        } else {
          for (let y = 0; y < f.h; y++) rows.push(y);
        }
        for (let sy = 0; sy < f.h; sy++) {
          for (let sx = 0; sx < f.w; sx++) {
            const ci = f.indices[sy * f.w + sx];
            if (ci === f.transIndex || ci * 3 + 2 >= f.ct.length) continue;
            const di = ((f.gy + rows[sy]) * W + f.gx + sx) * 4;
            buf[di] = f.ct[ci * 3];
            buf[di + 1] = f.ct[ci * 3 + 1];
            buf[di + 2] = f.ct[ci * 3 + 2];
            buf[di + 3] = 255;
          }
        }
        outputs.push({ data: buf.slice(), delay: f.delay });
        prevDispose = f.dispose;
        prevRect = { gx: f.gx, gy: f.gy, w: f.w, h: f.h };
      }
      return outputs;
    }
  }

  global.GifReader = GifReader;
})(window);
