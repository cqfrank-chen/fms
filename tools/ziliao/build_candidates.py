# -*- coding: utf-8 -*-
"""资料包 → FMS 主数据候选清单（客户 / 包装模板），只生产候选与疑点，不做任何合并或臆造。

输入（由本目录其它脚本产出）：
  --texts   scan_texts.py 产出的 JSONL（Word 正文缓存）
  --sheets  scan_sheets.mjs 产出的 JSONL（Excel 结构与表头）
  --inv     scan_inventory.py 产出的 inventory.csv（全量文件清单）
输出：
  customer_candidates.csv       客户候选（含出现次数、证据文件、疑似别名分组、疑点）
  pack_template_candidates.csv  包装（唛头）模板候选（名称/内容/来源文件）
  candidates_summary.txt        人读摘要

用法：python build_candidates.py --texts texts.jsonl --sheets sheets.jsonl --inv inventory.csv --outdir <目录>
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import os
import re

BUY = re.compile(r"(?:需\s*方|买方|客户名称|客户)\s*[:：]?\s*([^\n|]{2,60})")
CN = re.compile(r"合同编号\s*[:：]?\s*([^\s\n|]{1,30})")
SUP = re.compile(r"供\s*方\s*[:：]?\s*([^\n|]{2,60})")
ADDR = re.compile(r"[（(][^（()）]*[)）]")
COMPANY = re.compile(r"公司|集团|工具|厂$|有限|co\.?\s*ltd|coltd|inc\.?|llc|gmbh", re.I)
MARK = re.compile(r"唛|标贴|不干胶|贴纸|彩卡|彩盒|正唛|侧唛|标签")
CONTRACT_WORD = re.compile(r"采购单|生产计划单|供需合同|订购|订单")


def clean_name(s: str) -> str:
    s = ADDR.sub("", s or "")
    s = re.sub(r"合同号.*$", "", s)
    s = re.sub(r"[\s\u3000]+", " ", s).strip()  # 折叠空白但保留词间空格（英文公司名不能粘成一坨）
    s = s.strip(":：,，.。、;；")
    return s


def load_texts(p):
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_sheets(p):
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--texts", required=True)
    ap.add_argument("--sheets", required=True)
    ap.add_argument("--inv", required=True)
    ap.add_argument("--outdir", required=True)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    ev = collections.defaultdict(lambda: {"buyer": collections.Counter(), "supplier": collections.Counter(),
                                          "contracts": collections.Counter(), "files": [], "tops": collections.Counter()})
    docs = list(load_texts(a.texts))

    # ---- Word 文档 ----
    for r in docs:
        t = r.get("text", "")
        if not t:
            continue
        rel = r["rel"].replace("\\", "/")
        top = rel.split("/")[1] if len(rel.split("/")) > 1 else "?"
        for m in BUY.finditer(t):
            nm = clean_name(m.group(1))
            if nm and (COMPANY.search(nm) or len(nm) <= 6):
                ev[nm]["buyer"][top] += 1
                if len(ev[nm]["files"]) < 4:
                    ev[nm]["files"].append(rel)
                ev[nm]["tops"][top] += 1
        for m in SUP.finditer(t):
            nm = clean_name(m.group(1))
            if nm:
                ev[nm]["supplier"][top] += 1
        for m in CN.finditer(t):
            ev["__contract__" + clean_name(m.group(1))]["contracts"][top] += 1

    # ---- Excel 合同 ----
    for s in load_sheets(a.sheets):
        if not s.get("ok"):
            continue
        rel = s["rel"].replace("\\", "/")
        top = rel.split("/")[1] if len(rel.split("/")) > 1 else "?"
        for sh in s["sheets"]:
            for row in sh["head"][:12]:
                cells = [str(c) for c in row]
                # 情形一：同一单元格 "需方：宁波XX有限公司"
                for c in cells:
                    for m in BUY.finditer(c):
                        nm = clean_name(m.group(1))
                        if nm:
                            ev[nm]["buyer"][top] += 1
                            if len(ev[nm]["files"]) < 4:
                                ev[nm]["files"].append(rel)
                            ev[nm]["tops"][top] += 1
                    for m in CN.finditer(c):
                        ev["__contract__" + clean_name(m.group(1))]["contracts"][top] += 1
                # 情形二：标签与公司名分列（"需      方：" | "宁波XX有限公司"）
                for j, c in enumerate(cells):
                    if re.fullmatch(r"\s*(需\s*方|买\s*方|客\s*户)\s*[:：]?\s*", c):
                        for k in range(j + 1, len(cells)):
                            nm = clean_name(cells[k])
                            if len(nm) >= 3:
                                ev[nm]["buyer"][top] += 1
                                if len(ev[nm]["files"]) < 4:
                                    ev[nm]["files"].append(rel)
                                ev[nm]["tops"][top] += 1
                                break
                    if re.fullmatch(r"\s*合同编号\s*[:：]?\s*", c):
                        for k in range(j + 1, len(cells)):
                            nm = clean_name(cells[k])
                            if nm:
                                ev["__contract__" + nm]["contracts"][top] += 1
                                break

    # ---- 客户候选 ----
    rows = []
    for nm, d in ev.items():
        if nm.startswith("__contract__"):
            continue
        total_buyer = sum(d["buyer"].values())
        total_sup = sum(d["supplier"].values())
        kind = []
        if total_buyer:
            kind.append("需方")
        if total_sup:
            kind.append("供方")
        if not kind:
            continue
        rows.append({
            "候选名称": nm,
            "角色": "+".join(kind),
            "出现次数": total_buyer or total_sup,
            "需方次数": total_buyer,
            "供方次数": total_sup,
            "所属资料文件夹": "、".join(f"{k}({v})" for k, v in d["tops"].most_common()),
            "是否公司名": "是" if COMPANY.search(nm) else "否(疑似人名/简称)",
            "证据文件样例": " ; ".join(d["files"][:3]),
        })
    # 置信度：公司名 → 高；短名（2~6 字，非句子）→ 待人工判断；其余 → 低（疑似正则误抓）
    STOP = re.compile(r"编号|结算|确认|索赔|全责|品牌|型号|描述|发票|结清|自己回去贴|不干胶|logo|标签|标贴|滚字|定牌")
    for r in rows:
        nm = r["候选名称"]
        if COMPANY.search(nm) and len(nm) <= 30:
            r["置信度"] = "高（公司名）"
            r["疑点"] = ""
        elif 2 <= len(nm) <= 8 and not STOP.search(nm) and r["需方次数"] >= 1:
            r["置信度"] = "中（疑似简称/人名，需人工确认）"
            r["疑点"] = "非完整公司名：可能是客户简称、联系人姓名或品牌名，禁止自动并入任何客户档案"
        else:
            r["置信度"] = "低（疑似正则误抓，建议丢弃）"
            r["疑点"] = "来自合同条款/表头等非客户字段"
    rows.sort(key=lambda r: ({"高（公司名）": 0, "中（疑似简称/人名，需人工确认）": 1}.get(r["置信度"], 2), -r["需方次数"]))
    custp = os.path.join(a.outdir, "customer_candidates.csv")
    with open(custp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # ---- 包装（唛头）模板候选 ----
    packs = []
    seen = set()
    for r in docs:
        rel = r["rel"].replace("\\", "/")
        base = os.path.basename(rel)
        stem = os.path.splitext(base)[0]
        if not MARK.search(base):
            continue
        if not r.get("ok") or not r.get("chars"):
            continue
        if r.get("has_pic_field"):
            continue  # 图文混排：正文是 INCLUDEPICTURE 字段，需视觉识别，不入库
        uniq = r.get("uniq") or []
        content = "\n".join(uniq).strip()
        if len(content) < 2:
            continue
        # 排除「文件名带标贴字样、正文其实是合同/计划单/库存表」的误抓
        if CONTRACT_WORD.search(content) or re.search(r"库存|对账|送货单", content) or len(content) > 400:
            continue
        top = rel.split("/")[1] if len(rel.split("/")) > 1 else "?"
        key = (top, re.sub(r"\s+", "", content).lower())
        if key in seen:
            continue
        seen.add(key)
        packs.append({
            "客户文件夹": top,
            "模板名": f"{top}-{stem}"[:80],
            "label内容": content[:500],
            "字符数": r.get("chars"),
            "来源文件": rel,
        })
    packs.sort(key=lambda x: (x["客户文件夹"], x["模板名"]))
    packp = os.path.join(a.outdir, "pack_template_candidates.csv")
    with open(packp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(packs[0].keys()))
        w.writeheader()
        w.writerows(packs)

    # ---- 摘要 ----
    txt = []
    txt.append("客户线索条目: %d" % len(rows))
    txt.append("其中公司名: %d；疑似人名/简称: %d" % (sum(1 for r in rows if r["是否公司名"] == "是"),
                                          sum(1 for r in rows if r["是否公司名"] != "是")))
    txt.append("")
    txt.append("== 需方（客户候选）— 高置信公司名 ==")
    for r in rows:
        if r["需方次数"] and r["置信度"].startswith("高"):
            txt.append("  x%-4d %-34s 文件夹=%s" % (r["需方次数"], r["候选名称"], r["所属资料文件夹"]))
    txt.append("")
    txt.append("== 需方 — 中置信（简称/人名，需人工确认，禁止自动合并） ==")
    for r in rows:
        if r["需方次数"] and r["置信度"].startswith("中"):
            txt.append("  x%-4d %-20s 文件夹=%s" % (r["需方次数"], r["候选名称"], r["所属资料文件夹"]))
    txt.append("")
    txt.append("== 供方（我方/本厂，不应建为客户） ==")
    for r in rows:
        if r["供方次数"] and not r["需方次数"]:
            txt.append("  x%-4d %s" % (r["供方次数"], r["候选名称"]))
    txt.append("")
    txt.append("== 包装（唛头）模板候选: %d 条 ==" % len(packs))
    bytop = collections.Counter(p["客户文件夹"] for p in packs)
    for k, v in bytop.most_common():
        txt.append("  %-10s %d" % (k, v))
    txt.append("")
    for p in packs[:15]:
        txt.append("  ▸ %s" % p["模板名"])
        txt.append("      内容: %s" % p["label内容"].replace("\n", " / ")[:120])
        txt.append("      来源: %s" % p["来源文件"])
    open(os.path.join(a.outdir, "candidates_summary.txt"), "w", encoding="utf-8").write("\n".join(txt))
    print("customers=%d packs=%d" % (len(rows), len(packs)))


if __name__ == "__main__":
    main()
