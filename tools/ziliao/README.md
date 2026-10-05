# tools/ziliao —— 客户资料包（唛头/采购单/计划单）分析与导入工具

一次性工具集，用于把「客户资料包 zip」变成 FMS 可用的主数据候选，并做试点导入。
**不改动任何既有业务逻辑**：分析类脚本只读资料包；导入类脚本只调用既有 HTTP 接口。

## 流水线

~~~
zip ──extract_ziliao.py──► 解压目录 + _manifest.csv
                              │
                              ├── scan_inventory.py ──► inventory.csv     （目录画像）
                              ├── scan_texts.py     ──► texts.jsonl       （Word 正文缓存）
                              ├── scan_sheets.mjs   ──► sheets.jsonl      （Excel 表头/样例）
                              └── pdf_info.py       ──► pdfs.jsonl        （PDF 文本层/扫描件判定）
                                        │
                                        ▼
                            build_candidates.py ──► customer_candidates.csv
                                                    pack_template_candidates.csv
                                                    candidates_summary.txt
                                        │
                                        ▼
              import_customers.mjs / import_pack_templates.mjs ──► 本地库（走 FMS HTTP 接口）
              ai_parse_batch.mjs                               ──► AI 识单抽样报告（只读不建单）
~~~

## 环境变量（三个 .mjs 脚本共用）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| FMS_BASE | http://127.0.0.1:3100/api | FMS API 基址（云端部署时改成云端地址） |
| FMS_USER / FMS_PASS | admin / Fms@2026 | 登录账号（需 admin 或 planner 角色） |
| ROOT | D:/futures/ziliao-data | 已解压资料包根目录（ai_parse_batch.mjs 用） |

.mjs 通过 createRequire 复用 apps/api/node_modules 的 SheetJS / ExcelJS，无需额外安装依赖。
Python 脚本只用运行时自带的 stdlib + Pillow（pdf_info.py / 图片画像用），doc_text.py 零依赖。

## 常用命令

~~~powershell
# 1) 解压（先按需修改脚本里的 ZP / DEST 常量）
python tools/ziliao/extract_ziliao.py

# 2) 目录画像
python tools/ziliao/scan_inventory.py D:\futures\ziliao-data D:\futures\_work\inventory.csv

# 3) Word 正文批量抽取（.doc 零依赖抽取器）
python tools/ziliao/scan_texts.py D:\futures\ziliao-data D:\futures\_work\texts.jsonl

# 4) Excel 结构与表头
node tools/ziliao/scan_sheets.mjs D:\futures\ziliao-data D:\futures\_work\sheets.jsonl

# 5) PDF 文本层 / 扫描件判定
python tools/ziliao/pdf_info.py D:\futures\ziliao-data D:\futures\_work\pdfs.jsonl

# 6) 生成客户候选 + 包装(唛头)模板候选
python tools/ziliao/build_candidates.py ^
  --texts D:\futures\_work\texts.jsonl ^
  --sheets D:\futures\_work\sheets.jsonl ^
  --inv D:\futures\_work\inventory.csv ^
  --outdir D:\futures\_work\cand

# 7) 试点导入（走 FMS 既有接口；会先 preview 再 commit，再复跑一次验证幂等）
node tools/ziliao/import_customers.mjs --in D:\futures\_work\cand\customer_pilot_input.csv --out D:\futures\_work\pilot
node tools/ziliao/import_pack_templates.mjs --in D:\futures\_work\cand\pack_template_candidates.csv --out D:\futures\_work\pilot

# 8) AI 识单抽样验证（只读，不建单）
node tools/ziliao/ai_parse_batch.mjs --files D:\futures\_work\ai_files.json --out D:\futures\_work\pilot
~~~

## 单独用 .doc 抽取器

~~~powershell
python tools/ziliao/doc_text.py "D:\futures\ziliao-data\ziliao\正恒公司\ZEHEN 唛头.doc"
python tools/ziliao/doc_text.py 某文件.doc --json     # 带元信息（字符数、OLE 流名）
~~~

~~~python
import sys; sys.path.insert(0, "tools/ziliao")
from doc_text import extract_text
r = extract_text(r"D:\...\某唛头.doc")
print(r["chars"], r["text"])
~~~

## 注意事项

* import_* 脚本会**真的写库**。请先指向一个空的试点库（本报告用的是独立容器 fms-ziliao-pg，宿主机 15433）。
* build_candidates.py 只产出「候选 + 置信度 + 疑点」，**不做任何别名合并**；
  客户别名合并必须由业务人工裁定（见 D:\futures\ziliao-analysis.md §5.1）。
* 结算方式 / 账期天数在资料包里没有证据，导入时一律留空，不臆造。
