/**
 * 生成应用与托盘图标（无第三方依赖）：
 *  - resources/icon.png  256×256：圆角蓝色底 + 白色字母 C
 *  - resources/tray.png   32×32：同设计托盘图（Windows 按 DPI 缩放）
 *  - build/icon.ico       多尺寸（16/24/32/48/64/128/256，Vista+ PNG 压缩）
 * 用法：node scripts/gen-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- CRC32 ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 圆角方块内判定。 */
function inRoundedRect(x, y, size, pad, radius) {
  const min = pad;
  const max = size - pad;
  if (x < min || x >= max || y < min || y >= max) return false;
  const cx = x < min + radius ? min + radius : x > max - radius ? max - radius : x;
  const cy = y < min + radius ? min + radius : y > max - radius ? max - radius : y;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const pad = Math.max(1, Math.round(size * 0.015));
  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.33;
  const rInner = size * 0.205;
  // 开口：右侧 ±42° 不绘制环带
  const gap = (42 * Math.PI) / 180;
  // 品牌蓝（与渲染层 accent 接近），底部略深做轻渐变
  const top = [76, 139, 245];
  const bottom = [63, 125, 238];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inBg = inRoundedRect(x, y, size, pad, radius);
      if (!inBg) continue;

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const inRing = dist <= rOuter && dist >= rInner;
      const inGap = Math.abs(ang) <= gap;

      let r;
      let g;
      let b;
      let a = 255;
      if (inRing && !inGap) {
        // 白色 C，抗锯齿：环内外缘 1px 过渡
        const edge = Math.min(dist - rInner, rOuter - dist);
        r = 255;
        g = 255;
        b = 255;
        a = Math.round(255 * Math.max(0, Math.min(1, edge + 0.5)));
      } else {
        const k = y / size;
        r = Math.round(top[0] + (bottom[0] - top[0]) * k);
        g = Math.round(top[1] + (bottom[1] - top[1]) * k);
        b = Math.round(top[2] + (bottom[2] - top[2]) * k);
      }
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

/** 将多张 PNG 打包为单个 ICO（PNG 压缩条目，Vista+ 支持）。 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  const blobs = [];
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const e = 16 * i;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; // palette
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

mkdirSync(join(root, "resources"), { recursive: true });
mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "resources", "icon.png"), encodePng(256, render(256)));
writeFileSync(join(root, "resources", "tray.png"), encodePng(32, render(32)));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(
  join(root, "build", "icon.ico"),
  encodeIco(icoSizes.map((size) => ({ size, png: encodePng(size, render(size)) }))),
);
console.log("generated resources/icon.png, resources/tray.png, build/icon.ico");
