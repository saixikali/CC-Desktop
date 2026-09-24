// asar 读写最小自包含实现（仅依赖 Node 内置模块）
// 格式：[8 字节 sizePickle][headerPickle][文件数据]
//   sizePickle   = u32 payloadSize(=4) + u32 headerPickleLength
//   headerPickle = u32 payloadSize + (i32 jsonByteLength + JSON 字符串，按 4 字节对齐)
import crypto from 'node:crypto';
import fs from 'node:fs';

export const BLOCK_SIZE = 4 * 1024 * 1024;

export function readArchive(asarPath) {
  const buf = fs.readFileSync(asarPath);
  if (buf.length < 16) throw new Error('文件过小，不是合法 asar');
  const headerSize = buf.readUInt32LE(4);
  if (headerSize <= 0 || 8 + headerSize > buf.length) throw new Error('asar 头尺寸非法');
  const headerBuf = buf.subarray(8, 8 + headerSize);
  const payloadSize = headerBuf.readUInt32LE(0);
  if (payloadSize + 4 > headerBuf.length) throw new Error('header pickle payload 尺寸非法');
  const jsonLen = headerBuf.readInt32LE(4);
  if (jsonLen <= 0 || 8 + jsonLen > headerBuf.length) throw new Error('header JSON 长度非法');
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen));
  return { buf, header, headerSize, dataStart: 8 + headerSize };
}

export function buildArchive(header, dataBufs) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32LE(json.length, 0);
  let payload = Buffer.concat([lenBuf, json]);
  const pad = (4 - (payload.length % 4)) % 4;
  if (pad) payload = Buffer.concat([payload, Buffer.alloc(pad)]);
  const headerPickle = Buffer.alloc(4 + payload.length);
  headerPickle.writeUInt32LE(payload.length, 0);
  payload.copy(headerPickle, 4);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, ...dataBufs]);
}

export function findNode(root, entryPath) {
  let cur = root;
  for (const seg of entryPath.split('/').filter(Boolean)) {
    if (!cur || !cur.files || !cur.files[seg]) {
      throw new Error(`asar 中找不到成员: ${entryPath}`);
    }
    cur = cur.files[seg];
  }
  return cur;
}

// 遍历所有节点，对文件/目录/链接分别回调
export function walkAll(root, onFile, onOther) {
  const walk = (node) => {
    for (const child of Object.values(node.files ?? {})) {
      if (child.files) walk(child);
      else if (typeof child.offset === 'string') onFile(child);
      else onOther?.(child);
    }
  };
  walk(root);
}

export function listPackedPaths(root, prefix = '') {
  const out = [];
  for (const [name, child] of Object.entries(root.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) out.push(...listPackedPaths(child, p));
    else if (typeof child.offset === 'string') out.push(p);
  }
  return out;
}

export function readPackedData(archive, node) {
  if (node.size <= 0) return Buffer.alloc(0);
  if (node.unpacked) {
    throw new Error('该成员是 unpacked 文件，请从 <asar>.unpacked 目录读取');
  }
  const off = parseInt(node.offset, 10);
  const start = archive.dataStart + off;
  if (off < 0 || start + node.size > archive.buf.length) {
    throw new Error(`成员数据越界 offset=${node.offset} size=${node.size}`);
  }
  return archive.buf.subarray(start, start + node.size);
}

export function integrityOf(buf) {
  const blocks = [];
  for (let o = 0; o < buf.length; o += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(o, Math.min(o + BLOCK_SIZE, buf.length))).digest('hex'));
  }
  if (buf.length === 0) blocks.push(crypto.createHash('sha256').update(buf).digest('hex'));
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks
  };
}
