# -*- coding: utf-8 -*-
"""按「文件夹=客户」口径生成三类清单（甲方裁定：以文件夹为识别主体，同一文件夹内的都是同一家）。

输入（本目录其它脚本产出，均为只读缓存）：
  --inv    scan_inventory.py 的全量清单 CSV（path,is_dir,ext,size,company,sub）
  --texts  scan_texts.py 的 Word 正文 JSONL（rel/text/chars/uniq/has_pic_field/ok）
输出（写入 --outdir）：
  customer_folders.csv          客户清单：**顶层客户文件夹**（客户名=文件夹名），含规模与待确认项
  pack_template_candidates.csv  包装（唛头）模板候选：客户列 = 顶层客户文件夹，内容 = 去重后的唛头正文
  subfolder_reference.csv       二级子文件夹候选清单（**只备查、不导入**），标注归属顶层客户
  folder_lists_summary.txt      人读摘要（数量分布 + 前若干条样例）

裁定口径（本脚本严格遵守，不做任何臆造与合并）：
  1. 客户 = 顶层文件夹，客户名 = 文件夹名；**不做跨文件夹合并、不做别名归一**。
  2. 二级子文件夹不是客户，只作为「订单批次/项目标签」候选清单输出备查。
  3. 本厂（供方）名称**绝不进入客户表**：客户清单只来自文件夹名，脚本不会去读合同抬头取客户名。
  4. 包装模板沿用既有候选规则（文件名含唛/标贴/不干胶…、正文非空、排除图文混排与单据误抓、按客户+正文去重）。

用法：
  python build_folder_lists.py --inv inventory.csv --texts texts.jsonl --outdir <目录>
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import os
import re

MARK = re.compile(r"唛|标贴|不干胶|贴纸|彩卡|彩盒|正唛|侧唛|标签")
CONTRACT_WORD = re.compile(r"采购单|生产计划单|供需合同|订购|订单")
OTHER_DOC = re.compile(r"库存|对账|送货单")

# 供方（本厂）名称：只用于**输出提示**，确保这些名字不会出现在客户清单里
SUPPLIER_HINTS = ["一洲", "维克工具厂"]


def norm_parts(path: str):
    """路径 → 片段列表：去掉尾部分隔符与可能存在的 'ziliao/' 外壳层。"""
    parts = [p for p in (path or "").replace("\\", "/").split("/") if p]
    if parts and parts[0] == "ziliao":
        parts = parts[1:]
    return parts


def load_inventory(path):
    dirs = set()
    files = []
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            parts = norm_parts(row["path"])
            if not parts:
                continue
            is_dir = str(row.get("is_dir", "0")).strip() in ("1", "True", "true")
            if is_dir:
                dirs.add("/".join(parts))
            else:
                files.append({"parts": parts, "ext": (row.get("ext") or "").lower(),
                              "size": int(row.get("size") or 0)})
    return dirs, files


def load_texts(path):
    out = []
    if not path or not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inv", required=True)
    ap.add_argument("--texts", required=True)
    ap.add_argument("--outdir", required=True)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    dirs, files = load_inventory(a.inv)

    # ---------- ① 客户清单：顶层文件夹 ----------
    top_files = collections.Counter()
    top_size = collections.Counter()
    top_ext = collections.defaultdict(collections.Counter)
    for f in files:
        top = f["parts"][0]
        top_files[top] += 1
        top_size[top] += f["size"]
        top_ext[top][f["ext"]] += 1

    # 二级条目 = 「顶层客户/第二段名字」，来源有三处：
    #   · 二级目录本身（可能不直接落文件）      → 类型「二级子文件夹」
    #   · depth>=3 的文件路径第二段             → 类型「二级子文件夹」
    #   · 直接放在客户目录下的文件（depth2=82） → 类型「客户目录直属文件」
    # 说明：分析报告里的「二级子文件夹 328 个」= 246 个二级目录 + 82 个客户目录直属文件（同为「二级条目」）。
    # 本清单把两者都列出并标注类型，数字以磁盘实测为准，不硬凑 328。
    sub_kind = {}
    for d in dirs:
        parts = d.split("/")
        if len(parts) == 2:
            sub_kind[(parts[0], parts[1])] = "二级子文件夹"
    sub_files = collections.Counter()
    sub_size = collections.Counter()
    for f in files:
        parts = f["parts"]
        if len(parts) >= 3:
            key = (parts[0], parts[1])
            sub_kind.setdefault(key, "二级子文件夹")
            sub_files[key] += 1
            sub_size[key] += f["size"]
        elif len(parts) == 2:
            key = (parts[0], parts[1])
            sub_kind.setdefault(key, "客户目录直属文件")
            sub_files[key] += 1
            sub_size[key] += f["size"]

    customers = []
    for top in sorted(top_files, key=lambda x: -top_files[x]):
        subs = {k[1] for k in sub_kind if k[0] == top and sub_kind[k] == "二级子文件夹"}
        excel = sum(v for e, v in top_ext[top].items() if e in ("xls", "xlsx"))
        word = sum(v for e, v in top_ext[top].items() if e in ("doc", "docx"))
        customers.append({
            "客户名称": top,
            "来源": "顶层客户文件夹名（文件夹=客户）",
            "文件数": top_files[top],
            "体积MB": round(top_size[top] / 1048576.0, 1),
            "二级子文件夹数": len(subs),
            "Excel份数": excel,
            "Word份数": word,
            "待确认项": "客户名按甲方裁定取文件夹名；合同抬头「需方」全称仅作一致性校验，不覆盖客户名、不合并",
        })
    custp = os.path.join(a.outdir, "customer_folders.csv")
    with open(custp, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(customers[0].keys()))
        w.writeheader()
        w.writerows(customers)

    # ---------- ② 二级子文件夹清单（备查，不导入） ----------
    sub_rows = []
    for (top, sub) in sorted(sub_kind, key=lambda k: (sub_kind[k], k[0], k[1])):
        sub_rows.append({
            "顶层客户文件夹": top,
            "二级条目": sub,
            "类型": sub_kind[(top, sub)],
            "文件数": sub_files[(top, sub)],
            "体积MB": round(sub_size[(top, sub)] / 1048576.0, 1),
            "用途": "订单批次/项目标签候选（**不是客户**，不导入客户表）",
        })
    subp = os.path.join(a.outdir, "subfolder_reference.csv")
    with open(subp, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=["顶层客户文件夹", "二级条目", "类型", "文件数", "体积MB", "用途"])
        w.writeheader()
        w.writerows(sub_rows)

    # ---------- ③ 包装（唛头）模板候选 ----------
    packs = []
    seen = set()
    used_names = set()
    for r in load_texts(a.texts):
        rel = (r.get("rel") or "").replace("\\", "/")
        parts = norm_parts(rel)
        if len(parts) < 2:
            continue
        top = parts[0]
        base = os.path.basename(rel)
        stem = os.path.splitext(base)[0]
        if not MARK.search(base):
            continue
        if not r.get("ok") or not r.get("chars"):
            continue
        if r.get("has_pic_field"):
            continue  # 图文混排：正文只剩 INCLUDEPICTURE（临时 png 已丢失）→ 需视觉识别，不入库
        content = "\n".join(r.get("uniq") or []).strip()
        if len(content) < 2:
            continue
        if CONTRACT_WORD.search(content) or OTHER_DOC.search(content) or len(content) > 400:
            continue
        key = (top, re.sub(r"\s+", "", content).lower())
        if key in seen:
            continue
        seen.add(key)
        # 模板名：客户文件夹前缀 + 文件名词干，并保证**同一批内名字唯一**。
        # 原因：不同二级文件夹下常出现同名唛头文件（如多个 "1-101 唛头.doc"），
        # 实测 146 条候选只有 119 个不同名字；撞名会让云端出现同名模板且无法按名幂等。
        # 规则：撞名 → 依次追加 -2/-3…；名字超长（>76）→ 截断并追加来源路径短哈希。
        base_name = top + "-" + stem
        if len(base_name) > 76:
            base_name = base_name[:69] + "-" + hashlib.md5(rel.encode("utf-8")).hexdigest()[:6]
        tpl_name = base_name
        k = 2
        while tpl_name in used_names:
            tpl_name = base_name[:76 - len(str(k)) - 1] + "-" + str(k)
            k += 1
        used_names.add(tpl_name)
        packs.append({
            "客户文件夹": top,
            "模板名": tpl_name,
            "label内容": content[:500],
            "字符数": r.get("chars"),
            "来源文件": rel,
        })
    packs.sort(key=lambda x: (x["客户文件夹"], x["模板名"]))
    packp = os.path.join(a.outdir, "pack_template_candidates.csv")
    with open(packp, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=["客户文件夹", "模板名", "label内容", "字符数", "来源文件"])
        w.writeheader()
        w.writerows(packs)

    # ---------- 摘要 ----------
    lines = []
    lines.append("== 口径：文件夹=客户（甲方裁定）==")
    lines.append("客户（顶层文件夹）: %d 家" % len(customers))
    for c in customers:
        lines.append("  %-10s 文件 %-5d 二级子文件夹 %-4d Excel %-4d Word %-4d" % (
            c["客户名称"], c["文件数"], c["二级子文件夹数"], c["Excel份数"], c["Word份数"]))
    lines.append("")
    n_dir = sum(1 for r in sub_rows if r["类型"] == "二级子文件夹")
    n_file = sum(1 for r in sub_rows if r["类型"] == "客户目录直属文件")
    lines.append("二级条目（备查，不导入）: %d 个 = 二级子文件夹 %d + 客户目录直属文件 %d" % (len(sub_rows), n_dir, n_file))
    lines.append("（报告里的「二级子文件夹 328 个」= 246 个二级目录 + 82 个客户目录直属文件；此处按磁盘实测分列）")
    bytop = collections.Counter(r["顶层客户文件夹"] for r in sub_rows if r["类型"] == "二级子文件夹")
    for k, v in bytop.most_common():
        lines.append("  %-10s 二级子文件夹 %d" % (k, v))
    lines.append("")
    lines.append("包装（唛头）模板候选: %d 条" % len(packs))
    bp = collections.Counter(p["客户文件夹"] for p in packs)
    for k, v in bp.most_common():
        lines.append("  %-10s %d" % (k, v))
    lines.append("")
    lines.append("== 供方（本厂）名称：绝不进客户表 ==")
    for h in SUPPLIER_HINTS:
        hit = [c["客户名称"] for c in customers if h in c["客户名称"]]
        lines.append("  %-10s 命中客户清单: %s" % (h, hit or "无 ✅"))
    lines.append("")
    lines.append("前 15 条模板：")
    for p in packs[:15]:
        lines.append("  ▸ %s" % p["模板名"])
        lines.append("      内容: %s" % p["label内容"].replace("\n", " / ")[:110])
        lines.append("      来源: %s" % p["来源文件"])
    open(os.path.join(a.outdir, "folder_lists_summary.txt"), "w", encoding="utf-8").write("\n".join(lines))

    print("customers=%d subfolders=%d packs=%d -> %s" % (len(customers), len(sub_rows), len(packs), a.outdir))


if __name__ == "__main__":
    main()
