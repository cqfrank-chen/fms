# -*- coding: utf-8 -*-
"""Word 97-2003 (.doc, OLE2/CFB + FIB piece table) 纯文本抽取器 —— 零第三方依赖。

为什么不用 mammoth/antiword/LibreOffice：
  本机（以及云端 Linux 容器）没有 LibreOffice，pip 也不保证可联网；
  .doc 是 OLE2 复合文档，正文存在 WordDocument 流的 FIB piece table（CLX）里，
  自己解析 CFB + CLX 即可拿到正文，无需任何外部二进制。

用法：
  python doc_text.py <file.doc> [--json]
  from doc_text import extract_doc_text, open_cfb
"""
from __future__ import annotations

import json
import struct
import sys

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
DIFSECT = 0xFFFFFFFC
NOSTREAM = 0xFFFFFFFF

# MS-OFFCRYPTO / [MS-OSHARED] 规定的「压缩」piece 字节 → Unicode 映射（cp1252 扩展区）
CP1252_EXT = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178,
}


class CFBError(Exception):
    pass


class CFB:
    """极简 OLE2 复合文档（CFB）读取器：只实现读取所需的最小集合。"""

    def __init__(self, data: bytes):
        if data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise CFBError("not a CFB/OLE2 file")
        self.d = data
        self.sector_shift = struct.unpack_from("<H", data, 0x1E)[0]
        self.mini_sector_shift = struct.unpack_from("<H", data, 0x20)[0]
        if not (7 <= self.sector_shift <= 20) or not (2 <= self.mini_sector_shift <= self.sector_shift):
            raise CFBError("bad sector shift")
        self.sector_size = 1 << self.sector_shift
        self.mini_sector_size = 1 << self.mini_sector_shift
        self.num_fat_sectors = struct.unpack_from("<I", data, 0x2C)[0]
        self.first_dir_sector = struct.unpack_from("<I", data, 0x30)[0]
        self.mini_cutoff = struct.unpack_from("<I", data, 0x38)[0] or 4096
        self.first_minifat = struct.unpack_from("<I", data, 0x3C)[0]
        self.num_minifat = struct.unpack_from("<I", data, 0x40)[0]
        self.first_difat = struct.unpack_from("<I", data, 0x44)[0]
        self.num_difat = struct.unpack_from("<I", data, 0x48)[0]
        self._per_sector = self.sector_size // 4
        if self.sector_size <= 0 or len(data) < self.sector_size:
            raise CFBError("truncated CFB")
        self._build_fat()
        self._build_dir()
        self._build_minifat()

    # ---------- 基础设施 ----------
    def _off(self, sector: int) -> int:
        return (sector + 1) * self.sector_size

    def _sector(self, sector: int) -> bytes:
        o = self._off(sector)
        return self.d[o:o + self.sector_size]

    def _chain(self, start: int, fat, limit: int = 1 << 22):
        """按 FAT 链取扇区号序列（带环检测）。"""
        out = []
        sec = start
        seen = set()
        while sec not in (ENDOFCHAIN, FREESECT) and sec < 0xFFFFFFFA:
            if sec in seen or len(out) > limit:
                break
            seen.add(sec)
            out.append(sec)
            if sec >= len(fat):
                break
            sec = fat[sec]
        return out

    def _build_fat(self):
        difat = list(struct.unpack_from("<109I", self.d, 0x4C))
        sec, n = self.first_difat, self.num_difat
        while sec < 0xFFFFFFFA and n > 0:
            entries = struct.unpack_from("<%dI" % self._per_sector, self.d, self._off(sec))
            difat.extend(entries[:-1])
            sec = entries[-1]
            n -= 1
        fat = []
        for fs in difat:
            if fs >= 0xFFFFFFFA:
                continue
            if len(fat) >= self.num_fat_sectors * self._per_sector:
                break
            o = self._off(fs)
            if o + self.sector_size > len(self.d):
                break
            fat.extend(struct.unpack_from("<%dI" % self._per_sector, self.d, o))
        if not fat:
            raise CFBError("empty FAT")
        self.fat = fat

    def _build_dir(self):
        raw = self._read_chain(self.first_dir_sector, self.fat)
        self.entries = []
        for i in range(0, len(raw) - 127, 128):
            e = raw[i:i + 128]
            name_len = struct.unpack_from("<H", e, 0x40)[0]
            if name_len < 2 or name_len > 64:
                name = ""
            else:
                name = e[:name_len - 2].decode("utf-16-le", "replace")
            self.entries.append({
                "name": name,
                "type": e[0x42],
                "start": struct.unpack_from("<I", e, 0x74)[0],
                "size": struct.unpack_from("<Q", e, 0x78)[0],
                "index": len(self.entries),
            })
        self.by_name = {e["name"]: e for e in self.entries if e["type"] in (2, 5)}
        root = next((e for e in self.entries if e["type"] == 5), None)
        if root is None:
            raise CFBError("no root entry")
        self.root = root
        self.ministream = self._read_chain(root["start"], self.fat)[:root["size"]] if root["start"] < 0xFFFFFFFA else b""

    def _build_minifat(self):
        self.minifat = []
        if self.first_minifat < 0xFFFFFFFA:
            raw = self._read_chain(self.first_minifat, self.fat)
            self.minifat = list(struct.unpack_from("<%dI" % (len(raw) // 4), raw, 0))

    def _read_chain(self, start: int, fat, mini: bool = False) -> bytes:
        if start >= 0xFFFFFFFA:
            return b""
        if mini:
            out = []
            sec = start
            seen = set()
            while sec not in (ENDOFCHAIN, FREESECT) and sec < 0xFFFFFFFA and sec not in seen:
                seen.add(sec)
                o = sec * self.mini_sector_size
                out.append(self.ministream[o:o + self.mini_sector_size])
                if sec >= len(self.minifat):
                    break
                sec = self.minifat[sec]
            return b"".join(out)
        return b"".join(self._sector(s) for s in self._chain(start, fat))

    def read_stream(self, name: str) -> bytes:
        e = self.by_name.get(name)
        if e is None:
            raise CFBError("stream not found: %s" % name)
        if e["size"] < self.mini_cutoff:
            return self._read_chain(e["start"], self.minifat, mini=True)[:e["size"]]
        return self._read_chain(e["start"], self.fat)[:e["size"]]

    def stream_names(self):
        return [e["name"] for e in self.entries if e["type"] == 2]


# ---------- Word 97 正文抽取 ----------

def _fib_table_name(word_doc: bytes) -> str:
    """FIB base flags 的 bit 9 = fWhichTblStm：0 -> 0Table，1 -> 1Table。"""
    if len(word_doc) < 0x0C:
        raise CFBError("FIB too small")
    flags = struct.unpack_from("<H", word_doc, 0x0A)[0]
    return "1Table" if (flags >> 9) & 1 else "0Table"


def _piece_table(word_doc: bytes, table: bytes):
    """返回 [(cp_start, cp_end, file_offset, is_compressed), ...]"""
    if len(word_doc) < 0x01AA:
        raise CFBError("FIB too small")
    fc_clx, lcb_clx = struct.unpack_from("<II", word_doc, 0x01A2)
    if fc_clx == 0 or lcb_clx == 0:
        return []
    clx = table[fc_clx:fc_clx + lcb_clx]
    # 跳过 Prc 数组（clxt==0x01: 1 字节类型 + 2 字节 cbGrpprl + grpprl）
    i = 0
    while i < len(clx) and clx[i] == 0x01:
        if i + 3 > len(clx):
            return []
        cb = struct.unpack_from("<H", clx, i + 1)[0]
        i += 3 + cb
    if i >= len(clx) or clx[i] != 0x02:
        return []
    lcb = struct.unpack_from("<I", clx, i + 1)[0]
    plc = clx[i + 5:i + 5 + lcb]
    if len(plc) < 4:
        return []
    n = (len(plc) - 4) // 12
    if n <= 0:
        return []
    cps = struct.unpack_from("<%dI" % (n + 1), plc, 0)
    pieces = []
    base = 4 * (n + 1)
    for k in range(n):
        fc = struct.unpack_from("<I", plc, base + k * 8 + 2)[0]
        if fc & 0x40000000:
            pieces.append((cps[k], cps[k + 1], (fc & 0x3FFFFFFF) // 2, True))
        else:
            pieces.append((cps[k], cps[k + 1], fc, False))
    return pieces


def extract_doc_text(path: str) -> dict:
    with open(path, "rb") as f:
        data = f.read()
    cfb = CFB(data)
    word_doc = cfb.read_stream("WordDocument")
    tname = _fib_table_name(word_doc)
    try:
        table = cfb.read_stream(tname)
    except CFBError:
        table = cfb.read_stream("1Table" if tname == "0Table" else "0Table")
    pieces = _piece_table(word_doc, table)

    parts = []
    for (cp0, cp1, off, comp) in pieces:
        n = cp1 - cp0
        if n <= 0:
            continue
        if comp:
            raw = word_doc[off:off + n]
            chars = []
            for b in raw:
                if b in CP1252_EXT:
                    chars.append(chr(CP1252_EXT[b]))
                elif b < 0x80:
                    chars.append(chr(b))
                else:
                    chars.append(chr(b))  # 0xA0-0xFF 与 Latin-1 一致
            parts.append("".join(chars))
        else:
            raw = word_doc[off:off + n * 2]
            parts.append(raw.decode("utf-16-le", "replace"))
    text = _normalize("".join(parts))
    return {
        "path": path,
        "chars": len(text),
        "text": text,
        "streams": cfb.stream_names(),
    }


CTRL_MAP = {
    "\r": "\n", "\x07": "\t", "\x0c": "\n", "\x0b": "\n", "\x0e": "\n",
    "\x01": "", "\x02": "", "\x03": "", "\x04": "", "\x05": "", "\x08": "",
    "\x13": "", "\x14": "", "\x15": "", "\x1e": "", "\x1f": "",
}


def _normalize(text: str) -> str:
    out = []
    for ch in text:
        if ch in CTRL_MAP:
            out.append(CTRL_MAP[ch])
        elif ord(ch) < 0x20 and ch not in "\t\n":
            continue
        else:
            out.append(ch)
    s = "".join(out)
    s = s.replace("\ufffd", "")
    lines = [ln.rstrip() for ln in s.split("\n")]
    lines = [ln for ln in lines if ln.strip()]
    return "\n".join(lines)


def extract_docx_text(path: str) -> dict:
    """docx（OOXML，纯 zip+XML，零依赖）。"""
    import re
    import zipfile

    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        chunks = []
        for n in names:
            if re.match(r"^word/(document|header\d*|footer\d*)\.xml$", n):
                xml = z.read(n).decode("utf-8", "replace")
                xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
                xml = re.sub(r"</w:p>", "\n", xml)
                xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
                txt = re.sub(r"<[^>]+>", "", xml)
                import html
                chunks.append(html.unescape(txt))
        media = [n for n in names if n.startswith("word/media/")]
        emb = [n for n in names if n.startswith("word/embeddings/")]
    text = _normalize("\n".join(chunks))
    return {"path": path, "chars": len(text), "text": text,
            "media": len(media), "embeddings": len(emb)}


def extract_text(path: str) -> dict:
    low = path.lower()
    if low.endswith(".docx"):
        return extract_docx_text(path)
    if low.endswith(".doc"):
        return extract_doc_text(path)
    raise ValueError("unsupported: " + path)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Word .doc/.docx 纯文本抽取（零依赖）")
    ap.add_argument("path")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = extract_text(a.path)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        sys.stdout.buffer.write((r["text"] + "\n").encode("utf-8"))
