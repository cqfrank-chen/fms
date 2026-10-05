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

## 本轮新增脚本（I17 甲方裁定 5 项 · 报价导入 / 落草稿）

| 文件 | 作用 | 用法 |
| --- | --- | --- |
| **find_quote_files.mjs** | 在资料包里**检索报价单**并抽样表结构（文件名含 报价/价格/单价/价目/quote/price，扩展名 xls/xlsx/doc/docx/pdf/csv）；产出清单 + 抽样明细 + 可映射性判断 + **候选报价行 CSV** | node find_quote_files.mjs [--root D:/futures/ziliao-data] [--out tools/ziliao] [--rows 12] |
| **import_quotes_cloud.mjs** | 报价批量导入云端：**只调既有接口** `/api/quotes/import/preview` → `/commit`（分类统计/档案匹配/同键改价全由服务端负责，与界面导入同一口径）；先 `--dry-run` 看统计，幂等（复跑 = 全改价，不新增） | $env:FMS_BASE="https://…/api"; node import_quotes_cloud.mjs --in tools/ziliao/quote_seed_candidates.csv --dry-run |
| **draft_orders_from_parse.mjs**（增强） | 批量落草稿：新增 `--base`、`--dry-run` 输出**识单层面预估统计**（客户已建档/未建档、报价补价行、仍缺价行、缺数量行、按文件夹客户分组） | node draft_orders_from_parse.mjs --csvdir <切片目录> [--csvdir …] --dry-run |

产物（跑 `find_quote_files.mjs` 后落在仓库 tools/ziliao/）：
`quote_files.csv`（报价单清单）、`quote_files_samples.json`（抽样明细）、`quote_files_summary.txt`（摘要与结论）、
`quote_seed_candidates.csv`（可导入的候选行，直接喂 `import_quotes_cloud.mjs`）。

## 本轮新增脚本（任务一/二/三 · 产品建档候选 + 历史成交价种子）

| 文件 | 作用 | 用法 |
| --- | --- | --- |
| **lib/ziliao-extract.mjs** | 抽取共享库：Excel 合同（表头含单价列）/ .doc 切片（计划单、采购单）/ Word 正文元数据；文本归一与服务端 `normalizeToken` **逐字符同口径**；产品类型推断只认字面证据，推断不出一律 `tbd` | 被下面两个 CLI import |
| **extract_products.mjs** | **任务一**：从 570 份带单价列合同 + 214 份计划单 + 36 份采购单/带价单据抽产品 → 产品建档候选 CSV（含建议类型/默认包装/出现次数/来源文件数/置信度）+ **疑似同产品不同写法**清单（**不自动合并**） | node tools/ziliao/extract_products.mjs |
| **extract_price_seeds.mjs** | **任务二**：从合同与 .doc 采购单抽 `(客户=文件夹名, 产品名, 单价, 币种, 日期)` → 报价种子 CSV（表头含**来源**列：contract / doc） | node tools/ziliao/extract_price_seeds.mjs |
| **import_products_cloud.mjs** | 产品批量导入：**只调既有接口** `/api/master-data/import/preview\|commit`（target=products）；`--dry-run` 先看 新增/更新/跳过/错误；幂等（按产品名归一判重，复跑全 skip） | node tools/ziliao/import_products_cloud.mjs --in tools/ziliao/products_candidates.csv --dry-run |
| **analyze_price_gap.mjs** | **任务三配套**：报价种子导入后仍缺价的**原因分析**（命名不一致 / 无价源），产出逐产品写法的线索清单；近似线索**必须数字指纹一致**才算 | node tools/ziliao/analyze_price_gap.mjs |
| **build_model_aliases.mjs** | **任务三**：产出**型号对照候选**（计划单写法 ↔ 合同/报价写法），用于解锁缺价；硬门槛：**数字部分含前导零逐字符一致** + 只允许描述/品牌前缀（子串）差异；**只出候选供人工确认，不写库、不自动应用** | node tools/ziliao/build_model_aliases.mjs |
| **size_normalization_audit.sql** | **型号归一口径 SQL 核对**（只读）：档案/报价计数是否与候选 CSV 对齐、前导零型号是否各自建档、同族尺寸清单、重复档案、危险对检查；附（默认不执行的）修复片段 | docker exec -i fms-postgres psql -U fms -d fms -f - < tools/ziliao/size_normalization_audit.sql |

产物（跑完落在仓库 tools/ziliao/）：
`products_candidates.csv`（产品建档候选）、`products_variants.csv`（疑似同产品不同写法，**未合并**，带「差异类别」列）、
`products_variants_A_文本差异.csv`（A 类·可合并候选，附建议标准名）、`products_variants_B_尺寸差异.csv`（B 类·**不合并，各自建档**）、
`products_size_merge_audit.csv`（旧口径尺寸折叠审计）、`products_candidates_summary.txt`、
`contract_price_seeds.csv`（历史成交价报价种子，直接喂 `import_quotes_cloud.mjs`）、`contract_price_seeds_summary.txt`、
`contract_price_seed_size_merge_audit.csv`（报价种子侧的尺寸折叠审计）、
`model_alias_candidates.csv` + `model_alias_summary.txt`（型号对照候选，供人工确认）、
`price_gap_analysis.csv` + `price_gap_summary.txt`（剩余缺价原因）。

## 型号归一口径（甲方更正 2026 · **最高优先级**）

> 甲方更正原文：「**0-GPN 和 00-GPN 是同一型号的不同尺寸**。」

1. **前导零 / 数字位数差异 = 不同尺寸 = 不同产品**，绝不合并、绝不各自覆盖；
2. 归一化**只碰文本外壳**：空格 / 全角半角 / 大小写 / 标点；**数字部分（含前导零、位数、后缀号数）原样保留、逐字符比较**；
3. 判定「是不是同一个产品型号」的唯一口径 = `normalizeToken` 相同 **且** `digitSignature` 相同（`productIdentityKey`）；
   服务端实现在 `apps/api/src/ai/table-parser.service.ts`，工具侧在 `tools/ziliao/lib/ziliao-extract.mjs`（逐字符同口径）；
4. 变体清单据此重新分类：
   * **A 类·纯文本差异**（组内数字指纹全一致）→ 可合并候选，附建议标准名，**仍不自动合并**；
   * **B 类·数字/尺寸差异**（组内出现 ≥2 种数字指纹）→ **同型号不同尺寸，不合并，各自建档**；
5. 子串容错（"计划单写 1-1-101、合同写 Victor 乙炔割嘴 1-1-101"）**必须带数字守卫**：
   数字部分逐字符一致才允许命中；**绝不为凑覆盖率做无约束子串匹配**（宁缺勿错，价格错误代价高）。

> 报价导入的**来源**列：`contract`（合同成交价）/ `doc`（.doc 单据提取）/ `import`（用户上传的报价表）/ `manual`；
> 留空沿用既有口径 `import`（向后兼容）。服务端词表见 apps/api/src/db/schema.ts 的 `QUOTE_SOURCES`。

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

# 15) 【任务一】抽产品建档候选 + 疑似同产品不同写法（只读资料包）
node tools/ziliao/extract_products.mjs

# 16) 【任务二】抽历史成交价报价种子（只读资料包）
node tools/ziliao/extract_price_seeds.mjs

# 17) 【任务三配套】剩余缺价原因分析（近似线索已加数字守卫）
node tools/ziliao/analyze_price_gap.mjs

# 17b) 【任务三】型号对照候选（计划单写法 ↔ 合同写法；只出候选，供人工确认）
node tools/ziliao/build_model_aliases.mjs

# 17c) 型号归一口径 SQL 核对（只读；核对「上一轮导入有没有把不同尺寸合并」）
docker exec -i fms-postgres psql -U fms -d fms -f - < tools/ziliao/size_normalization_audit.sql
# 云端：psql "postgresql://fms:<密码>@<云端主机>/fms" -f tools/ziliao/size_normalization_audit.sql

# 18) 产品建档导入（先 --dry-run；FMS_BASE 指向目标环境）
$env:FMS_BASE = "https://<云端地址>/api"
node tools/ziliao/import_products_cloud.mjs --in tools/ziliao/products_candidates.csv --dry-run
node tools/ziliao/import_products_cloud.mjs --in tools/ziliao/products_candidates.csv

# 19) 历史成交价导入（currency 归一到 CNY；幂等键 = 客户+产品+生效日期，默认 upsert 改价）
node tools/ziliao/import_quotes_cloud.mjs --in tools/ziliao/contract_price_seeds.csv --dry-run
node tools/ziliao/import_quotes_cloud.mjs --in tools/ziliao/contract_price_seeds.csv
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
* **型号归一（2026 甲方更正）**：`0-GPN` 与 `00-GPN` 是同一型号的**不同尺寸** → 各自建档、各自定价；
  任何脚本都不得删除前导零、折叠数字位，也不得用无约束子串匹配把它们判成同一产品（见上节口径）。
* 结算方式 / 账期天数在资料包里没有证据，导入时一律留空，不臆造。
* **幂等**：客户导入自带「同名（去空格后）」去重 → 复跑 summary.new=0、全部 skip；唛头模板按「模板名」先查后插 → 复跑 created=0、skipped=全部。
* **.doc 计划单族没有单价列** → 识单结果必然缺 unitPrice（管线如实报「缺数量或单价，已保留 N 行待人工补全」），需人工补价；
  采购单族有「不含税价」列，能出完整产品行。
* **.doc 计划单抬头的交期没有年份**（如「交货时间: 9/20」）→ 管线按当前年份归一并在 notes 里提示「请人工确认年份」，不要直接采信。
