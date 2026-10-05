# -*- coding: utf-8 -*-
"""批量抽取资料包内所有 .doc/.docx 正文 → JSONL 缓存（供画像/唛头入库复用）。

用法：
  python scan_texts.py <资料包根目录> <输出.jsonl> [--limit N]
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from doc_text import extract_text  # noqa: E402

INC_PIC = re.compile(r'INCLUDEPICTURE', re.I)


def uniq_lines(text: str, maxn: int = 12):
    """唛头文档正文通常是「同一版标签重复排版 N 次」，按行去重还原标签内容。"""
    seen, out = set(), []
    for ln in text.split("\n"):
        k = ln.strip()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(k)
        if len(out) >= maxn:
            break
    return out


def main():
    root, outp = sys.argv[1], sys.argv[2]
    limit = 0
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    t0 = time.time()
    n = 0
    stats = Counter()
    with open(outp, "w", encoding="utf-8") as fo:
        for dp, dn, fn in os.walk(root):
            for f in sorted(fn):
                low = f.lower()
                if not (low.endswith(".doc") or low.endswith(".docx")):
                    continue
                p = os.path.join(dp, f)
                rel = os.path.relpath(p, root).replace("\\", "/")
                rec = {"rel": rel, "ext": low.rsplit(".", 1)[1], "size": os.path.getsize(p)}
                try:
                    r = extract_text(p)
                    text = r["text"]
                    rec["chars"] = r["chars"]
                    rec["has_pic_field"] = bool(INC_PIC.search(text))
                    rec["media"] = r.get("media", 0)
                    rec["embeddings"] = r.get("embeddings", 0)
                    rec["uniq"] = uniq_lines(text)
                    rec["text"] = text[:20000]
                    rec["ok"] = True
                    if r["chars"] == 0:
                        stats["empty_text"] += 1
                    elif rec["has_pic_field"]:
                        stats["pic_mixed"] += 1
                    else:
                        stats["pure_text"] += 1
                except Exception as e:
                    rec["ok"] = False
                    rec["err"] = repr(e)
                    stats["error"] += 1
                fo.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n += 1
                if n % 200 == 0:
                    print("[%d] %.0fs %s" % (n, time.time() - t0, dict(stats)), flush=True)
                if limit and n >= limit:
                    break
            if limit and n >= limit:
                break
    print("DONE n=%d %.0fs %s" % (n, time.time() - t0, dict(stats)), flush=True)


if __name__ == "__main__":
    main()
