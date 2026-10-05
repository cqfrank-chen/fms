# -*- coding: utf-8 -*-
"""Word 97-2003 (.doc) 表格切分层 —— 把 Word 表格切成与 Excel 同构的二维矩阵（CSV）。

为什么需要这一层：
  嵊州海田 / 正恒 两家的订单资料**没有 Excel 合同**（正恒 xls/xlsx = 0，嵊州海田 Excel 只有 1 份且非合同），
  全是 .doc 计划单/采购单。要复用 FMS 那条「表头规则映射 + folderCustomer」的识单管线，
  先把 Word 表格还原成矩阵即可 —— 不必另起一套识别逻辑。

Word 二进制里的表格结构（本层依据，均为实测）：
  · 单元格结束标记 = 0x07；段落结束 = 0x0D；图片/对象 = 0x01；
  · 一个表格行的最后一个单元格之后还有一个「行标记」，在流里表现为**紧邻的一个空单元格**（0x07 0x07）；
  · 单元格内可以有多段（内部用 0x0D 分行），所以不能简单地按 0x0D 切行。

行切分规则（对上述真实结构设计，且在样例上逐份核对）：
  1. 单元格流 = 第一个 0x07 到最后一个 0x07 之间的内容按 0x07 切分；
  2. 表头行 = 开头的连续非空单元格，遇到「空单元格 + 其后紧跟非空单元格」即结束（那个空单元格就是行标记）；
  3. 数据行起点 = 非空单元格且其后 1~2 个单元格内出现纯数字（即「产品码 → 数量」这一真实排版），
     或自上一个行起点起已累计 ≥ 表头列数 个单元格（列数驱动的兜底切行）；
  4. 行内单元格做清洗：0x0D→空格、去图片占位符、去首尾空白；尾部的行标记空单元格丢掉。

局限（不臆造）：
  · 计划单族**没有单价列** → 矩阵里就没有单价，识单管线会如实报「缺 unitPrice」；
    采购单族有「含税单价」列（实测），能出完整产品行；
  · 表格几何完全错乱（跨页、嵌套表）的文档可能切错行 —— 脚本会输出 row_confidence 供人工挑拣。

用法：
  python doc_table.py <file.doc>                 # 打印矩阵（人读）
  python doc_table.py <file.doc> --json          # 打印 JSON（含 header/rows/meta）
  python doc_table.py --dir <根目录> --out <outdir>   # 批量：每份 .doc 出一个 .csv（utf-8-sig）
  python doc_table.py --dir <根目录> --jsonl <out.jsonl>
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from doc_text import extract_doc_raw  # noqa: E402

CELL = "\x07"
NUM = re.compile(r"^-?\d+(\.\d+)?$")
CODE = re.compile(r"[A-Za-z0-9]")


def looks_like_code(s: str) -> bool:
    """产品码/型号的样子：非空、非纯数字、不太长、含字母或数字（中文型号如「割嘴3-101 00#」也算）。"""
    return bool(s) and not NUM.match(s) and len(s) <= 40 and bool(CODE.search(s))
# 抬头行的字段（计划单/采购单共用）：合同号 / 交货时间 / 需方
HEAD_PATTERNS = [
    # 合同号 / 交货时间 / 需方（中文标签用 \u 转义书写，避免源码编码差异）
    ("poNo", re.compile(r"\u5408\u540c\u53f7\s*[:\uff1a]?\s*([^\u3000]{2,30})")),                       # 合同号
    ("poNoAlt", re.compile(r"\u8ba2\u5355\u53f7\s*[:\uff1a]?\s*([^\u3000]{2,30})")),                   # 订单号（部分计划单写法）
    ("dueDateRaw", re.compile(r"(?:\u4ea4\u8d27\u65f6\u95f4|\u4ea4\u8d27\u671f|\u4ea4\u8d27\u65e5\u671f|\u51fa\u8d27\u65e5\u671f|\u53d1\u8d27\u65e5\u671f|\u5b8c\u6210\u65e5\u671f)\s*[:\uff1a]?\s*([0-9]{1,4}\s*[./\u5e74-]\s*[0-9]{1,2}(?:\s*[./\u6708-]\s*[0-9]{1,2})?\s*\u65e5?)")),
    ("customerRaw", re.compile(r"\u9700\u65b9\s*[:\uff1a]?\s*([^\s\u3000]{1,20})")),                   # 需方
]
# 合同号后面常紧跟其它抬头字段（clean_cell 已把控制符折成空格）→ 截断到下一个字段标签
HEAD_STOP = re.compile(
    r"(?:\u4e0b\u5355\u65f6\u95f4|\u4ea4\u8d27\u65f6\u95f4|\u4ea4\u8d27\u671f|\u4ea4\u8d27\u65e5\u671f|\u7b7e\u5b57|\u90e8\u95e8|\u9700\u65b9|\u7535\u8bdd|\u65e5\u671f|"
    r"\u4ea7\u54c1\u540d\u79f0|\u54c1\u540d\u89c4\u683c|\u5408\u540c\u53f7|\u8ba2\u5355\u53f7|\u7b7e\u8ba2|\u7b7e\u5b9a|\u7b7e\u7ea6)")


def clean_cell(s: str) -> str:
    s = s.replace("\x0d", " ").replace("\x0b", " ").replace("\x0c", " ")
    s = "".join(ch for ch in s if ch >= " " or ch == "\t")
    s = s.replace("\x01", " ").replace("\x02", " ").replace("\x05", " ").replace("\x08", " ")
    s = s.replace("\u3000", " ")
    return re.sub(r"\s+", " ", s).strip()


def slice_tables(raw: str):
    """原始正文 → [{header: [...], rows: [[...]], rowConfidence: [...]}]"""
    first = raw.find(CELL)
    last = raw.rfind(CELL)
    if first < 0 or last <= first:
        return []
    # 关键：第一个单元格的文本在**第一个 0x07 之前**，所以要从所在段落的起点开始切，
    # 否则表头第一列（「品名规格」/「产品名称、规格」）会丢。
    start = raw.rfind("\x0d", 0, first) + 1
    region = raw[start:last + 1]
    cells = [clean_cell(c) for c in region.split(CELL)]
    # 表头行：开头连续非空
    i = 0
    while i < len(cells) and cells[i] == "":
        i += 1
    hstart = i
    while i < len(cells) and cells[i] != "":
        i += 1
    header = cells[hstart:i]
    if not header:
        return []
    ncol = len(header)
    # 数据行切分：**结构化行标记规则**（对上述真实字节结构设计，逐份核对过）
    #   行起点 = 「前一格是空单元格（行标记）」且「其后 1~2 格内出现纯数字（数量列）」；
    #   再加一个兜底：某行累计非空格数超过 ncol+3 就强制切行（防止个别文档缺行标记）。
    #   为什么不用「型号后跟数字」这种语义规则：采购单族的产品码本身就是数字（0/1/2…），
    #   与「数量」无法区分 —— 实测会把一行切成两行（见 106D7镀铬采购单.doc）。
    rows = []
    cur = []
    j = i
    while j < len(cells):
        c = cells[j]
        prev_empty = (j == 0) or (cells[j - 1] == "")
        nxt = next((cells[k] for k in range(j + 1, min(j + 3, len(cells))) if cells[k] != ""), "")
        row_start = (c != "") and prev_empty and bool(NUM.match(nxt))
        too_long = len([x for x in cur if x != ""]) > ncol + 3
        if cur and (row_start or too_long):
            rows.append(cur)
            cur = []
        cur.append(c)
        j += 1
    if cur:
        rows.append(cur)
    out = []
    conf = []
    for r in rows:
        # 丢掉行尾的行标记空单元格
        while r and r[-1] == "":
            r.pop()
        if not r:
            continue
        out.append(r)
        conf.append("high" if (len(r) <= ncol + 2 and r and len(r) > 1) else "low")
    return [{"header": header, "rows": out, "rowConfidence": conf}]


def build_matrix(raw: str):
    """表格 → 二维矩阵（第一行 = 表头）。多张表时取行数最多的那张（订单表通常最大）。"""
    tables = slice_tables(raw)
    if not tables:
        return [], []
    best = max(tables, key=lambda t: len(t["rows"]))
    width = max([len(best["header"])] + [len(r) for r in best["rows"]])
    matrix = [best["header"] + [""] * (width - len(best["header"]))]
    for r in best["rows"]:
        matrix.append(r + [""] * (width - len(r)))
    return matrix, best["rowConfidence"]


def head_fields(raw: str):
    """抬头行（表格之上/之下的同页文本）里抽 合同号 / 交货时间 / 需方 —— 与 Excel 侧同一口径。"""
    text = clean_cell(raw.split(CELL)[0] if CELL in raw else raw)
    got = {}
    for key, pat in HEAD_PATTERNS:
        m = pat.search(text)
        if m:
            val = HEAD_STOP.split(m.group(1))[0].strip(" :：,，")
            if not val:
                continue
            if key == "poNoAlt":
                got.setdefault("poNo", val)
            else:
                got[key] = val
    return got


def head_row(head: dict):
    """把抬头字段写成**与 Excel 同类布局的一行**（"需方:海田" / "合同号:26IIF02" / "交货时间: 9/30"），
    这样 CSV 走同一条识单管线时，抬头区扫描器（table-parser.service.scanContractHeader）能原样生效。"""
    cells = []
    if head.get("customerRaw"):
        cells.append("\u9700\u65b9:" + head["customerRaw"])
    if head.get("poNo"):
        cells.append("\u5408\u540c\u53f7:" + head["poNo"])
    if head.get("dueDateRaw"):
        cells.append("\u4ea4\u8d27\u65f6\u95f4: " + head["dueDateRaw"])
    return cells


def process(path: str, ext_note: str = "", tag: str = ""):
    raw = extract_doc_raw(path)
    matrix, conf = build_matrix(raw)
    head = head_fields(raw)
    hr = head_row(head)
    rel = os.path.relpath(path, ext_note).replace("\\", "/") if ext_note else os.path.basename(path)
    if tag:
        rel = tag + "/" + rel
    return {
        "path": path,
        "rel": rel,
        "matrix": matrix,
        "headRow": hr,
        "csvMatrix": ([hr] if hr else []) + matrix,
        "rowConfidence": conf,
        "headFields": head,
        "chars": len(raw),
        "rows": max(0, len(matrix) - 1),
    }


def main():
    ap = argparse.ArgumentParser(description="Word97 .doc 表格切分 → 矩阵/CSV")
    ap.add_argument("path", nargs="?")
    ap.add_argument("--dir")
    ap.add_argument("--out")
    ap.add_argument("--jsonl")
    ap.add_argument("--tag", help="rel 前缀（批量按客户文件夹切片时传客户名，产物路径第一段即客户）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.dir:
        if not a.out and not a.jsonl:
            print("批量模式需要 --out <目录> 或 --jsonl <文件>")
            return
        if a.out:
            os.makedirs(a.out, exist_ok=True)
        recs = []
        docs = []
        for dp, dn, fn in os.walk(a.dir):
            for f in fn:
                if f.lower().endswith(".doc"):
                    docs.append(os.path.join(dp, f))
        docs.sort()
        no_table = 0
        for p in docs:
            try:
                rec = process(p, a.dir, a.tag or "")
            except Exception as e:  # 单份失败不影响批量
                rec = {"path": p, "rel": os.path.relpath(p, a.dir).replace("\\", "/"), "error": str(e), "matrix": [], "rows": 0}
            recs.append(rec)
            if not rec.get("matrix"):
                no_table += 1
            if a.out and rec.get("matrix"):
                rel = rec["rel"].replace("/", "__")
                with open(os.path.join(a.out, rel + ".csv"), "w", newline="", encoding="utf-8-sig") as fh:
                    csv.writer(fh).writerows(rec["csvMatrix"])
        if a.jsonl:
            with open(a.jsonl, "w", encoding="utf-8") as fh:
                for r in recs:
                    fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        print("docs=%d with_table=%d no_table=%d rows=%d" % (len(recs), len(recs) - no_table, no_table, sum(r.get("rows", 0) for r in recs)))
        return

    if not a.path:
        ap.error("需要 <file.doc> 或 --dir <目录>")
    rec = process(a.path)
    if a.json:
        print(json.dumps(rec, ensure_ascii=False, indent=1))
        return
    print("抬头字段: " + json.dumps(rec["headFields"], ensure_ascii=False))
    for i, row in enumerate(rec["matrix"]):
        tag = "表头" if i == 0 else "行%d" % i
        print("%-4s | %s" % (tag, " | ".join(x[:40] for x in row)))


if __name__ == "__main__":
    main()
