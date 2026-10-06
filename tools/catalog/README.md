# tools/catalog —— 官方产品目录（切割嘴）解析 + 产品档案锚定

一次性工具集：把甲方提供的**2026 版产品目录**变成机器可读的型号矩阵，并用它**锚定**系统里
现有的产品档案（型号 = 基础型号 + 尺寸），再据此改进「取价 / 识单产品匹配」。

**只读目录、只改产品的目录锚定列**：不动订单 / 报价 / 库存，不合并任何不同 size 的档案。

## 甲方规则（最高优先级）

> 型号名**前面或后面**跟的数字、或 **# 号后**的数字 = **同一型号的不同 size**（不是不同型号的写法变体）。

因此 `0-GPN` / `00-GPN` / `000-GPN` = 型号 **GPN** 的 **size 0 / 00 / 000** 三档不同尺寸；
`106 #1` / `106 1#` = 型号 **106** 的 size 1；`1-1-101` = 型号 **1-101** 的 size 1。
**前导零逐字符比较**：0 ≠ 00 ≠ 000 ≠ 0000，绝不互相命中。

## 目录事实（实测，脚本产出）

| 指标 | 值 |
| --- | --- |
| 来源 | `D:/Dsh/project/product_catalog/Product_Model_Catalogue_photos_only.html` |
| 系列 / 款式 | **6**（AMERICAN 20 / JAPANESE 9 / BRITISH 2 / FRENCH 2 / AUSTRALIAN 2 / BRAZILIAN 2） |
| 型号 | **37** |
| 型号 × size 行 | **286** |
| 气体类型来源 | 每个规格表下方的 `<型号> FOR L.P.G` / `<型号> FOR ACE` 标注 |

## 流水线

```
目录 HTML ──parse_catalog.mjs──► catalog_models.json ──gen_server_catalog.mjs──► apps/api/src/ai/catalog-models.ts
                     │                    │
                     ├──► model_matrix.csv            （逐型号 × size，人工核对）
                     ├──► catalog_parse_report.md     （解析报告）
                     │
客户资料包 products_candidates.csv ──analyze_product_anchor.mjs──► product_anchor.csv
                     │                                            └► product_anchor_report.md（含待甲方确认清单）
                     └──apply_catalog_correction.mjs──► 产品档案的 catalog_* 8 列（幂等、可 dry-run）
```

## 脚本一览

| 文件 | 作用 | 用法 |
| --- | --- | --- |
| **parse_catalog.mjs** | 解析目录 HTML → `catalog_models.json` + `model_matrix.csv` + `catalog_parse_report.md`（零依赖） | `node tools/catalog/parse_catalog.mjs` |
| **gen_server_catalog.mjs** | `catalog_models.json` → 服务端 TS 数据模块（**生成文件，勿手改**） | `node tools/catalog/gen_server_catalog.mjs` |
| **lib/product-model.mjs** | 产品名 →（系列, 基础型号, size）解析（**工具侧**实现，与服务端同算法） | 被下面脚本 import |
| **analyze_product_anchor.mjs** | 1444 条产品候选逐个锚定 → 覆盖率报告 + 未锚定清单 | `node tools/catalog/analyze_product_anchor.mjs` |
| **apply_catalog_correction.mjs** | **修正脚本**：把锚定结果写进产品档案的 8 个新列（幂等 / 默认 dry-run / 只 update products） | 见下 |
| **verify_parity.mjs** | 工具侧 JS 与服务端 TS **双实现一致性校验**（1525 个真实名称逐条比对） | `node tools/catalog/verify_parity.mjs`（需先 build api） |
| **catalog_anchor_audit.sql** | 云端核对 SQL（**只读**）：锚定计数 / 前导零三档 / 未锚定抽样 | `psql "<DSN>" -f tools/catalog/catalog_anchor_audit.sql` |
| **dedupe_products.mjs** | **去重合并**：同一（基础型号 + size）的多条档案合并为一条（重挂 8 张外键后删除），类型以目录为准；默认 dry-run / 单事务 / 幂等 | 见下「去重合并」 |
| **lib/dedupe-core.mjs** | 去重的**纯函数核心**（解析 → 分组 → 选存活记录），被 CLI 与单测共用 | 被 import |
| **lib/catalog-type.mjs** | 目录（系列 + 气体）→ 系统产品类型（type）推导；映射不到保持 tbd | 被 import |
| **dedupe_products.test.mjs** | 去重判定**单元测试**（13 项：写法等价 / 不跨 size / 分组 / 存活选择 / 类型推导 / 真实 1444 条） | `node --test tools/catalog/dedupe_products.test.mjs` |
| **dedupe_audit.sql** | 合并后**只读**核对 SQL：条数 / 悬空引用 / 同型号同 size 只剩 1 条 / 前导零三档 / 类型分布 | `psql "<DSN>" -f tools/catalog/dedupe_audit.sql` |

产物（跑 `dedupe_products.mjs` 时自动写出）：
`dedupe_product_merges.csv`（被合并清单：分组键 / 系列 / 气体 / 类型 / 存活 id+名字 / 被合并 id+名字）、
`dedupe_unmerged_products.csv`（**未合并清单**：型号未锚定 或 名字没写 size 的逐条档案 + 原因 —— 交甲方逐族确认，脚本不猜）。

## 修正脚本用法（**默认 dry-run，不写库**）

```powershell
# 1) 先 dry-run 看统计（不改数据）
node tools/catalog/apply_catalog_correction.mjs --dsn "postgres://fms:<密码>@<主机>:5432/fms"

# 2) 确认无误后正式写入（幂等：第二次跑应改 0 行）
node tools/catalog/apply_catalog_correction.mjs --dsn "postgres://fms:<密码>@<主机>:5432/fms" --apply

# 可选：保守模式（只补空列，不覆盖已有值）；抽样验收
node tools/catalog/apply_catalog_correction.mjs --dsn "<DSN>" --fill-only --limit 50
```

**硬约束**（脚本自身实现，不是靠人记）：只 `select` / `update products`；
只写 `catalog_model / size_spec / series / gas_type / orifice_mm / thickness_range / catalog_anchor / catalog_note` 八列；
**不改 name、不改 type、不新增行、不删除行、不合并任何不同 size**；未锚定的行只打标 + 写原因。

## 去重合并（`dedupe_products.mjs`，**默认 dry-run**）

甲方规则：**型号前后带的数字 / # 号后的数字 / 「size」二字后的数字 = size**；
同一（基础型号 + size）的多种写法（`0-1-101` ≡ `1-101 割嘴 0#` ≡ `1-101 size0`）是**同一个产品**，合并为一条。
`0` / `00` / `000` 是**不同 size，绝不合并**；型号未锚定目录、或名字没写 size 的**保持现状**（只列清单，不猜）。

```powershell
# ① dry-run（只报告）：看分组数 / 合并前后条数 / 重挂引用行数 / 类型填充
node tools/catalog/dedupe_products.mjs --dsn "postgres://fms:<密码>@<主机>:5432/fms"

# ② 确认后正式写入（单事务；失败自动回滚）
node tools/catalog/dedupe_products.mjs --dsn "<DSN>" --apply

# ③ 复核：复跑 ② 应显示「需要修正的行数 0 / 复跑残留差异 0」
node tools/catalog/dedupe_products.mjs --dsn "<DSN>" --apply

# ④ 只读核对（条数 / 悬空引用 / 同型号同尺寸唯一 / 前导零三档 / 类型分布）
psql "<DSN>" -v ON_ERROR_STOP=1 -f tools/catalog/dedupe_audit.sql

# 单测（零依赖，不连库）
node --test tools/catalog/dedupe_products.test.mjs
# 端到端（真实库；需要一个已跑过迁移的库）
node apps/api/test/dedupe-products-e2e.mjs
```

**存活记录选择规则**（固定、可复算）：① 组内天然全是 `catalog_anchor=matched` →
② 完整度打分（type 具体 +2 / 默认包装 +1 / 默认工序路线 +1 / 安全库存>0 +1）高者优先 →
③ id 最小（最早建档）。**不丢信息**：存活记录为空的默认包装 / 工序路线从被合并记录补齐，安全库存取最大值；
被合并写法写入 `catalog_note` + 存档 CSV（`dedupe_product_merges.csv`）。
**未合并的两类档案**（型号未锚定目录 / 名字没写 size）保持现状，逐条写入
`dedupe_unmerged_products.csv`（类别 / id / 产品名 / 目录型号 / 原因），控制台同步打印分类计数。

**重挂范围**：`order_lines` / `plan_sheet_lines` / `goods_receipt_lines` / `outbound_lines` /
`stocktakes` / `product_quotes` / `inventory` / `product_processes`（运行时从 `information_schema` 查真实外键，
不写死表名）。**唯一约束**（`inventory(product_id,batch_no)` / `product_processes(product_id,process_id)`）
冲突的重复行先跳过、后删除并逐条计数上报。

**命名口径**：目录对产品的命名 = `catalog_model` + `size_spec`（一律以目录为准）；
显示名 `name` **保留存活记录原文**（甲方写法里带包装/刻字/重量/货号等目录没有的信息，改名会抹掉）——
如需统一改成目录标准名（`--canonical-name`，形如 `1-101 0#`），**须甲方确认后再开**。

**类型以目录为准**：matched 行的 `series` / `gas_type` / `type` 一律由目录推导
（`ACE→ACETYLENE`、`LPG→LPG`；款式 美式→`us_*`、英式→`uk_*`）；
日式 / 法式 / 澳式 / 巴西式在既有枚举（英式/美式 × 乙炔/丙烷）里**没有对应值** →
保持 `tbd` 并标记，**不臆造**；未锚定行不改 type（保持现状）。

---

## 口径边界（宁缺勿错）

1. 型号必须锚定到**目录里真实存在的 37 个型号**之一；
2. size 必须**逐字符**等于该型号的目录档位（前导零有意义）；
3. 型号边界必须干净：左侧是分隔符/串首，右侧是分隔符/串尾或紧跟一个**合法 size**
   —— 所以货号 `4154` 不会被当成型号 `41`、`1380` 不会被当成 `138` 的 size `0`；
4. 型号前后**同时**出现数字且不同 → 「尺寸有歧义」，**不出结论**（如 `割嘴 1-GPN 2#`）；
5. 型号锚定到了、但旁边数字不是目录档位（如 `PNME18` 的 `18`）→ 同样不锚定（尺寸没定死就不放过）；
6. 锚定不到的**保持现状**，进 `product_anchor_report.md` 的「待甲方确认清单」，绝不臆造。
