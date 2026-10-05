#!/usr/bin/env node
/**
 * Word 正文抽取器（.doc Word97 + .docx OOXML）—— 纯 Node、零第三方依赖
 * =====================================================================================
 * 为什么不用 python / LibreOffice / mammoth：
 *   本机与云端容器都不保证有 LibreOffice，pip 也不保证能联网。
 *   .doc 是 OLE2 复合文档（CFB），正文存在 WordDocument 流的 FIB piece table（CLX）里，
 *   自己解析 CFB + CLX 即可拿到正文；.docx 是 zip，Node 内置 zlib 就能解压。
 *   —— 因此本文件只依赖 node:fs / node:zlib / node:crypto，可直接命令行运行。
 *
 * 与 tools/ziliao/doc_text.py 的口径完全一致（同一份 CTRL 归一规则与行去重规则），
 * 便于「Node 版生成器」与「Python 版缓存」互相校对。
 *
 * 用法：  node doc-text.mjs <file.doc|file.docx> [--json]
 * 作为库：import { extractText, extractDocRaw, uniqLines } from './doc-text.mjs';
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

/** [MS-OSHARED] 规定的「压缩」piece 字节 → Unicode（cp1252 扩展区） */
const CP1252_EXT = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/** 极简 OLE2 复合文档（CFB）读取器：只实现读 stream 所需的最小集合 */
export class Cfb {
  constructor(d) {
    if (d.length < 512 || d.readUInt32LE(0) !== 0xe011cfd0 || d.readUInt32LE(4) !== 0xe11ab1a1) {
      throw new Error('not a CFB/OLE2 file');
    }
    this.d = d;
    this.sectorShift = d.readUInt16LE(0x1e);
    this.miniSectorShift = d.readUInt16LE(0x20);
    if (!(this.sectorShift >= 7 && this.sectorShift <= 20) || !(this.miniSectorShift >= 2 && this.miniSectorShift <= this.sectorShift)) {
      throw new Error('bad sector shift');
    }
    this.sectorSize = 1 << this.sectorShift;
    this.miniSectorSize = 1 << this.miniSectorShift;
    this.numFatSectors = d.readUInt32LE(0x2c);
    this.firstDirSector = d.readUInt32LE(0x30);
    this.miniCutoff = d.readUInt32LE(0x38) || 4096;
    this.firstMiniFat = d.readUInt32LE(0x3c);
    this.numMiniFat = d.readUInt32LE(0x40);
    this.firstDifat = d.readUInt32LE(0x44);
    this.numDifat = d.readUInt32LE(0x48);
    this.perSector = this.sectorSize >> 2;
    if (this.sectorSize <= 0 || d.length < this.sectorSize) throw new Error('truncated CFB');
    this.#buildFat();
    this.#buildDir();
    this.#buildMiniFat();
  }

  #off(sector) {
    return (sector + 1) * this.sectorSize;
  }

  #sector(sector) {
    const o = this.#off(sector);
    return this.d.subarray(o, o + this.sectorSize);
  }

  /** 按 FAT 链取扇区号（带环检测） */
  #chain(start, fat, limit = 1 << 22) {
    const out = [];
    const seen = new Set();
    let sec = start;
    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < 0xfffffffa) {
      if (seen.has(sec) || out.length > limit) break;
      seen.add(sec);
      out.push(sec);
      if (sec >= fat.length) break;
      sec = fat[sec];
    }
    return out;
  }

  #buildFat() {
    const difat = [];
    for (let i = 0; i < 109; i++) difat.push(this.d.readUInt32LE(0x4c + i * 4));
    let sec = this.firstDifat;
    let n = this.numDifat;
    while (sec < 0xfffffffa && n > 0) {
      const base = this.#off(sec);
      const entries = [];
      for (let i = 0; i < this.perSector; i++) entries.push(this.d.readUInt32LE(base + i * 4));
      difat.push(...entries.slice(0, -1));
      sec = entries[entries.length - 1];
      n -= 1;
    }
    const fat = [];
    for (const fs of difat) {
      if (fs >= 0xfffffffa) continue;
      if (fat.length >= this.numFatSectors * this.perSector) break;
      const o = this.#off(fs);
      if (o + this.sectorSize > this.d.length) break;
      for (let i = 0; i < this.perSector; i++) fat.push(this.d.readUInt32LE(o + i * 4));
    }
    if (!fat.length) throw new Error('empty FAT');
    this.fat = fat;
  }

  #buildDir() {
    const raw = this.#readChain(this.firstDirSector, this.fat);
    this.entries = [];
    for (let i = 0; i + 128 <= raw.length; i += 128) {
      const nameLen = raw.readUInt16LE(i + 0x40);
      let name = '';
      if (nameLen >= 2 && nameLen <= 64) name = raw.toString('utf16le', i, i + nameLen - 2);
      this.entries.push({
        name,
        type: raw.readUInt8(i + 0x42),
        start: raw.readUInt32LE(i + 0x74),
        size: Number(raw.readBigUInt64LE(i + 0x78)),
      });
    }
    this.byName = new Map();
    for (const e of this.entries) if (e.type === 2 || e.type === 5) this.byName.set(e.name, e);
    const root = this.entries.find((e) => e.type === 5);
    if (!root) throw new Error('no root entry');
    this.root = root;
    this.ministream = root.start < 0xfffffffa ? this.#readChain(root.start, this.fat).subarray(0, root.size) : Buffer.alloc(0);
  }

  #buildMiniFat() {
    this.minifat = [];
    if (this.firstMiniFat < 0xfffffffa) {
      const raw = this.#readChain(this.firstMiniFat, this.fat);
      for (let i = 0; i + 4 <= raw.length; i += 4) this.minifat.push(raw.readUInt32LE(i));
    }
  }

  #readChain(start, fat, mini = false) {
    if (start >= 0xfffffffa) return Buffer.alloc(0);
    if (mini) {
      const parts = [];
      const seen = new Set();
      let sec = start;
      while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < 0xfffffffa && !seen.has(sec)) {
        seen.add(sec);
        const o = sec * this.miniSectorSize;
        parts.push(this.ministream.subarray(o, o + this.miniSectorSize));
        if (sec >= this.minifat.length) break;
        sec = this.minifat[sec];
      }
      return Buffer.concat(parts);
    }
    return Buffer.concat(this.#chain(start, fat).map((s) => this.#sector(s)));
  }

  readStream(name) {
    const e = this.byName.get(name);
    if (!e) throw new Error('stream not found: ' + name);
    if (e.size < this.miniCutoff) return this.#readChain(e.start, this.minifat, true).subarray(0, e.size);
    return this.#readChain(e.start, this.fat).subarray(0, e.size);
  }

  streamNames() {
    return this.entries.filter((e) => e.type === 2).map((e) => e.name);
  }
}

// ---------- Word 97 正文 ----------

/** FIB base flags 的 bit 9 = fWhichTblStm：0 → 0Table，1 → 1Table */
function fibTableName(wordDoc) {
  if (wordDoc.length < 0x0c) throw new Error('FIB too small');
  const flags = wordDoc.readUInt16LE(0x0a);
  return (flags >> 9) & 1 ? '1Table' : '0Table';
}

/** 返回 [{cp0, cp1, off, comp}] */
function pieceTable(wordDoc, table) {
  if (wordDoc.length < 0x1aa) throw new Error('FIB too small');
  const fcClx = wordDoc.readUInt32LE(0x01a2);
  const lcbClx = wordDoc.readUInt32LE(0x01a6);
  if (!fcClx || !lcbClx) return [];
  const clx = table.subarray(fcClx, fcClx + lcbClx);
  let i = 0;
  while (i < clx.length && clx[i] === 0x01) {
    if (i + 3 > clx.length) return [];
    const cb = clx.readUInt16LE(i + 1);
    i += 3 + cb;
  }
  if (i >= clx.length || clx[i] !== 0x02) return [];
  const lcb = clx.readUInt32LE(i + 1);
  const plc = clx.subarray(i + 5, i + 5 + lcb);
  if (plc.length < 4) return [];
  const n = Math.floor((plc.length - 4) / 12);
  if (n <= 0) return [];
  const cps = [];
  for (let k = 0; k <= n; k++) cps.push(plc.readUInt32LE(k * 4));
  const pieces = [];
  const base = 4 * (n + 1);
  for (let k = 0; k < n; k++) {
    const fc = plc.readUInt32LE(base + k * 8 + 2);
    if (fc & 0x40000000) pieces.push({ cp0: cps[k], cp1: cps[k + 1], off: (fc & 0x3fffffff) >> 1, comp: true });
    else pieces.push({ cp0: cps[k], cp1: cps[k + 1], off: fc, comp: false });
  }
  return pieces;
}

function readDocStreams(buf) {
  const cfb = new Cfb(buf);
  const wordDoc = cfb.readStream('WordDocument');
  const tname = fibTableName(wordDoc);
  let table;
  try {
    table = cfb.readStream(tname);
  } catch {
    table = cfb.readStream(tname === '0Table' ? '1Table' : '0Table');
  }
  return { cfb, wordDoc, table };
}

/** 原始正文：不做控制符归一（保留 0x07 单元格标记 / 0x0D 段落标记 / 0x01 图片），供表格切分复用 */
export function extractDocRaw(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const { wordDoc, table } = readDocStreams(buf);
  const parts = [];
  for (const p of pieceTable(wordDoc, table)) {
    const n = p.cp1 - p.cp0;
    if (n <= 0) continue;
    if (p.comp) {
      const raw = wordDoc.subarray(p.off, p.off + n);
      let s = '';
      for (const b of raw) s += String.fromCharCode(CP1252_EXT[b] ?? b);
      parts.push(s);
    } else {
      parts.push(wordDoc.toString('utf16le', p.off, p.off + n * 2));
    }
  }
  return parts.join('');
}

const CTRL_MAP = {
  '\r': '\n', '\x07': '\t', '\x0c': '\n', '\x0b': '\n', '\x0e': '\n',
  '\x01': '', '\x02': '', '\x03': '', '\x04': '', '\x05': '', '\x08': '',
  '\x13': '', '\x14': '', '\x15': '', '\x1e': '', '\x1f': '',
};

/** 控制符归一 + 去空行（与 doc_text.py 的 _normalize 口径一致） */
export function normalizeText(text) {
  let out = '';
  for (const ch of text) {
    if (Object.prototype.hasOwnProperty.call(CTRL_MAP, ch)) out += CTRL_MAP[ch];
    else if (ch.charCodeAt(0) < 0x20 && ch !== '\t' && ch !== '\n') continue;
    else out += ch;
  }
  return out
    .split('\ufffd').join('')
    .split('\n')
    // 行尾去空白：用 JS 的 \s（含 \u00a0 等 Unicode 空白）对齐 python 的 str.rstrip()，
    // 只去空格/制表符会漏掉不换行空格（NBSP），导致「字符数」与 python 版差几个字符
    .map((ln) => ln.replace(/[\s\u001c-\u001f]+$/, ''))
    .filter((ln) => ln.trim())
    .join('\n');
}

// ---------- docx（OOXML：zip + XML，零依赖） ----------

/** 手工解析 zip（只用中央目录；本批 .docx 均 < 64MB，无 zip64） */
export function readZip(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (EOCD not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error('zip entry not found: ' + name);
      const nl = buf.readUInt16LE(e.localOff + 26);
      const el = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + nl + el;
      const data = buf.subarray(start, start + e.compSize);
      return e.method === 8 ? zlib.inflateRawSync(data) : data;
    },
  };
}

const HTML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function extractDocxText(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const zip = readZip(buf);
  const parts = [];
  for (const n of zip.names) {
    if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(n)) {
      let xml = zip.read(n).toString('utf8');
      xml = xml.replace(/<w:tab[^>]*\/>/g, '\t');
      xml = xml.replace(/<w:br[^>]*\/>/g, '\n');
      xml = xml.replace(/<\/w:p>/g, '\n');
      const txt = xml.replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
        if (g[0] === '#') {
          const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return HTML_ENT[g] ?? m;
      });
      parts.push(txt);
    }
  }
  const media = zip.names.filter((n) => n.startsWith('word/media/')).length;
  const embeddings = zip.names.filter((n) => n.startsWith('word/embeddings/')).length;
  const text = normalizeText(parts.join('\n'));
  return { chars: text.length, text, media, embeddings };
}

export function extractDocText(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const cfb = new Cfb(buf);
  const text = normalizeText(extractDocRaw(buf));
  return { chars: text.length, text, streams: cfb.streamNames() };
}

/** 统一入口：按扩展名分派 */
export function extractText(file) {
  const low = String(file).toLowerCase();
  if (low.endsWith('.docx')) return extractDocxText(file);
  if (low.endsWith('.doc')) return extractDocText(file);
  throw new Error('unsupported: ' + file);
}

/** 唛头文档正文通常是「同一版标签重复排版 N 次」→ 按行去重还原标签内容（上限 maxn 行） */
export function uniqLines(text, maxn = 12) {
  const seen = new Set();
  const out = [];
  for (const ln of String(text).split('\n')) {
    const k = ln.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= maxn) break;
  }
  return out;
}

export function md5Hex(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node doc-text.mjs <file.doc|file.docx> [--json]');
    process.exit(2);
  }
  const r = extractText(file);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ path: file, chars: r.chars, text: r.text }, null, 1));
  else process.stdout.write(r.text + '\n');
}
