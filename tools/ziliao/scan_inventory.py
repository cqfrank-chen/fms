# -*- coding: utf-8 -*-
"""扫描已解压的资料包目录 → 全量文件清单 CSV（不解析内容，只做目录画像）。

用法：
  python scan_inventory.py <已解压资料包根目录> <输出.csv>
输出列：path, is_dir, ext, size, company, sub
  company = 根目录下第一级文件夹（本批资料里即客户文件夹）
  sub     = 根目录下第二级文件夹（本批资料里即订单/品牌子文件夹）
"""
from __future__ import annotations

import csv
import os
import sys


def main():
    root, outp = sys.argv[1], sys.argv[2]
    # 根目录里可能有一层 ziliao/ 外壳，自动下钻
    entries = [e for e in os.listdir(root) if os.path.isdir(os.path.join(root, e))]
    if len(entries) == 1:
        inner = os.path.join(root, entries[0])
        if os.listdir(inner) and all(os.path.isdir(os.path.join(inner, x)) for x in os.listdir(inner)):
            root = inner
    rows = []
    for dp, dn, fn in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        for d in dn:
            full = os.path.join(rel_dir, d) if rel_dir != "." else d
            rows.append((full.replace("\\", "/"), 1, "", 0, "", ""))
        for f in fn:
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, root).replace("\\", "/")
            parts = rel.split("/")
            company = parts[0] if len(parts) > 1 else "(root)"
            sub = parts[1] if len(parts) > 2 else ""
            ext = os.path.splitext(f)[1].lower().lstrip(".")
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            rows.append((rel, 0, ext, size, company, sub))
    with open(outp, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["path", "is_dir", "ext", "size", "company", "sub"])
        w.writerows(rows)
    files = [r for r in rows if r[1] == 0]
    print("dirs=%d files=%d bytes=%d -> %s" % (len(rows) - len(files), len(files), sum(r[3] for r in files), outp))


if __name__ == "__main__":
    main()
