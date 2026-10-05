# -*- coding: utf-8 -*-
"""PDF 文本层 / 扫描件判定（零依赖）。

判定规则：
  - 解压所有 FlateDecode 流后统计文本算子 Tj/TJ/' /" 与图像算子 Do；
  - 命中 /Subtype /Image 或 DCTDecode/JPXDecode/CCITTFaxDecode → 含位图；
  - 文本算子少而图像多的 PDF 判为「扫描件」，文本算子多判为「电子版（有文本层）」。

用法：python pdf_info.py <目录|文件> <输出.jsonl>
"""
from __future__ import annotations

import json
import os
import re
import sys
import zlib

OBJ = re.compile(rb"(\d+)\s+(\d+)\s+obj(.*?)endobj", re.S)
STREAM = re.compile(rb"stream\r?\n(.*?)\r?\nendstream", re.S)


def analyze(path: str) -> dict:
    raw = open(path, "rb").read()
    info = {
        "path": path,
        "bytes": len(raw),
        "pages": len(re.findall(rb"/Type\s*/Page[^s]", raw)),
        "has_font": len(re.findall(rb"/Font", raw)),
        "has_tounicode": len(re.findall(rb"/ToUnicode", raw)),
        "images": len(re.findall(rb"/Subtype\s*/Image", raw)),
        "dct": len(re.findall(rb"/DCTDecode", raw)),
        "ccitt": len(re.findall(rb"/CCITTFaxDecode", raw)),
        "jpx": len(re.findall(rb"/JPXDecode", raw)),
        "flate": len(re.findall(rb"/FlateDecode", raw)),
    }
    text_ops = 0
    img_ops = 0
    path_ops = 0
    strings = []
    for m in OBJ.finditer(raw):
        body = m.group(3)
        if b"stream" not in body:
            continue
        for s in STREAM.finditer(body):
            data = s.group(1)
            if b"/FlateDecode" in body:
                try:
                    data = zlib.decompress(data)
                except Exception:
                    continue
            # 文本算子：注意导出器写法不统一（)Tj 与 ) Tj 都存在）
            text_ops += len(re.findall(rb"Tj|TJ", data))
            img_ops += len(re.findall(rb"/[^\s/]+\s+Do", data))
            path_ops += len(re.findall(rb"(?:^|\s)(?:re|m|l|c|v|y|f|F|f\*|S|s|B|b)\s", data))
            if len(strings) < 40:
                for sm in re.finditer(rb"\((?:[^()\\]|\\.){2,60}\)\s*Tj", data):
                    v = sm.group(0)[1:sm.group(0).rfind(b")")]
                    try:
                        strings.append(v.decode("latin-1"))
                    except Exception:
                        pass
    info["text_ops"] = text_ops
    info["img_ops"] = img_ops
    info["path_ops"] = path_ops
    info["sample_strings"] = strings[:25]
    # 判定：位图/字体/文本算子三者共同决定
    has_raster = info["images"] > 0 or info["dct"] > 0 or info["ccitt"] > 0 or info["jpx"] > 0
    if text_ops >= 20:
        info["kind"] = "electronic_mixed" if has_raster else "electronic_text"
    elif text_ops > 0:
        info["kind"] = "electronic_sparse_text"
    elif has_raster:
        info["kind"] = "scanned_image"
    elif img_ops > 0:
        info["kind"] = "vector_only"
    elif path_ops > 0:
        # 字体已转曲的矢量文件（设计稿直出）：无文本层、无位图，只能当图看
        info["kind"] = "vector_outlined"
    else:
        info["kind"] = "unknown"
    return info


def main():
    src, outp = sys.argv[1], sys.argv[2]
    files = []
    if os.path.isdir(src):
        for dp, dn, fn in os.walk(src):
            files += [os.path.join(dp, f) for f in fn if f.lower().endswith(".pdf")]
    else:
        files = [src]
    with open(outp, "w", encoding="utf-8") as fo:
        for p in sorted(files):
            try:
                r = analyze(p)
            except Exception as e:
                r = {"path": p, "kind": "ERROR", "err": repr(e)}
            fo.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("DONE", len(files))


if __name__ == "__main__":
    main()
