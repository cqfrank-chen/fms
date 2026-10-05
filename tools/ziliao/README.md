# tools/ziliao —— 客户资料包（唛头/采购单/计划单）分析与导入工具

一次性工具集，用于把「客户资料包 zip」变成 FMS 可用的主数据候选，并做试点导入。
**不改动任何既有业务逻辑**：分析类脚本只读资料包；导入类脚本只调用既有 HTTP 接口。

## 口径（甲方裁定 2026-10-05）

**「以文件夹为识别主体，同一文件夹内的，都是同一家的」**

1. 客户 = **顶层客户文件夹**（ziliao/<客户文件夹>/…，共 4 家：安宝公司 / 嵊州海田 / 尤耐克 / 正恒公司），**客户名 = 文件夹名**；
2. **不做跨文件夹合并、不做别名归一**（此前列的 5 组别名疑问全部作废）；
3. 二级子文件夹**不是客户** → 只出备查清单（246 个二级目录 + 82 个客户目录直属文件 = 328 个二级条目）；
4. 本厂（供方）名称**绝不进客户表** —— 客户清单只来自文件夹名，脚本不读合同抬头取客户名。

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

## 本轮新增脚本（文件夹=客户 + 识单复测 + .doc 切分）

| 文件 | 作用 | 用法 |
| --- | --- | --- |
| **ai_recheck_contracts.mjs** | 5 份最规整合同的**识单复测**：precision/recall/客户名/交期/合同号，改造前后同一脚本同一真值 | node ai_recheck_contracts.mjs --label AFTER（默认带 folderCustomer；加 --no-folder 复现旧口径） |
| **build_folder_lists.py** | 按「文件夹=客户」生成三类清单：客户清单（顶层文件夹）/ 唛头模板候选 / 二级条目备查清单 | python build_folder_lists.py --inv inventory.csv --texts texts.jsonl --outdir 目录 |
| **sync_folder_data.mjs** | 云端同步：客户走 master-data preview→commit，唛头走 /pack-templates；**幂等** | node sync_folder_data.mjs --customers customer_folders.csv --packs pack_template_candidates.csv [--dry-run] |
| **doc_table.py** | Word97 表格切分层：.doc 表格 → 与 Excel 同构的矩阵 CSV（含抬头行「需方/合同号/交货时间」） | python doc_table.py --dir <客户目录> --tag <客户名> --out csv目录 --jsonl out.jsonl |
| **ai_parse_doc_folder.mjs** | 把切片 CSV 送同一条识单管线（带 folderCustomer），覆盖嵊州海田/正恒 | node ai_parse_doc_folder.mjs --csvdir csv目录 --out 目录 |
| **doc-text.mjs** | **纯 Node 零依赖** Word 正文抽取器（.doc Word97/CFB + .docx zip），与 doc_text.py 同口径 | node doc-text.mjs 某文件.doc [--json] |
| **build_folder_lists.mjs** | **纯 Node 零依赖**生成客户清单 / 唛头模板候选（**不需要 python**），产出直接落到本目录 | node build_folder_lists.mjs [--root 解压目录] [--outdir 目录] |

## 环境变量（.mjs 脚本共用）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| --- | --- | --- |
| FMS_BASE | http://127.0.0.1:3100/api（**sync_folder_data.mjs 默认 http://127.0.0.1/api**） | FMS API 基址（云端部署时改成云端地址） |
| FMS_TOKEN | 空 | 已有 JWT 时直接用（sync 脚本优先用它，不再登录） |
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

# 9) 识单复测（5 份最规整合同；改造前后对比用同一命令，只换 --label）
node tools/ziliao/ai_recheck_contracts.mjs --label AFTER --out D:\futures\_work\recheck

# 10) 「文件夹=客户」清单（客户 / 唛头模板 / 二级条目备查）
python tools/ziliao/build_folder_lists.py --inv D:\futures\_work\inventory.csv ^
  --texts D:\futures\_work\texts.jsonl --outdir D:\futures\_work\folder_lists

# 11) 云端同步（先 --dry-run 只预览；正式跑会写库，复跑应全部 skip）
set FMS_BASE=https://<云端地址>/api
node tools/ziliao/sync_folder_data.mjs ^
  --customers D:\futures\_work\folder_lists\customer_folders.csv ^
  --packs D:\futures\_work\folder_lists\pack_template_candidates.csv --dry-run

# 12) .doc（嵊州海田/正恒，没有 Excel 合同）→ 切片 → 同一条识单管线
python tools/ziliao/doc_table.py --dir "D:\futures\ziliao-data\ziliao\嵊州海田" --tag 嵊州海田 ^
  --out D:\futures\_work\doc_csv_sz --jsonl D:\futures\_work\doc_slice_sz.jsonl
node tools/ziliao/ai_parse_doc_folder.mjs --csvdir D:\futures\_work\doc_csv_sz --out D:\futures\_work\doc_parse

# 13) 【推荐 · 纯 Node，不需要 python】生成客户清单 + 唛头模板候选，直接落到 tools/ziliao/ 固定文件名
node tools/ziliao/build_folder_lists.mjs
#    默认写入（与 python 版 build_folder_lists.py 输出**字节一致**）：
#      tools/ziliao/customer_folders.csv            4 行
#      tools/ziliao/pack_template_candidates.csv    146 行
#      tools/ziliao/subfolder_reference.csv         328 行（备查，不导入）
#      tools/ziliao/folder_lists_summary.txt

# 14) 云端同步（FMS_BASE 指向云端；先 --dry-run 只预览）
set FMS_BASE=https://<云端地址>/api
node tools/ziliao/sync_folder_data.mjs ^
  --customers tools/ziliao/customer_folders.csv ^
  --packs tools/ziliao/pack_template_candidates.csv --dry-run
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
* **幂等**：客户导入自带「同名（去空格后）」去重 → 复跑 summary.new=0、全部 skip；唛头模板按「模板名」先查后插 → 复跑 created=0、skipped=全部。
* **.doc 计划单族没有单价列** → 识单结果必然缺 unitPrice（管线如实报「缺数量或单价，已保留 N 行待人工补全」），需人工补价；
  采购单族有「不含税价」列，能出完整产品行。
* **.doc 计划单抬头的交期没有年份**（如「交货时间: 9/20」）→ 管线按当前年份归一并在 notes 里提示「请人工确认年份」，不要直接采信。
