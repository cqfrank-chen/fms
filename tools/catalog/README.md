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

## 口径边界（宁缺勿错）

1. 型号必须锚定到**目录里真实存在的 37 个型号**之一；
2. size 必须**逐字符**等于该型号的目录档位（前导零有意义）；
3. 型号边界必须干净：左侧是分隔符/串首，右侧是分隔符/串尾或紧跟一个**合法 size**
   —— 所以货号 `4154` 不会被当成型号 `41`、`1380` 不会被当成 `138` 的 size `0`；
4. 型号前后**同时**出现数字且不同 → 「尺寸有歧义」，**不出结论**（如 `割嘴 1-GPN 2#`）；
5. 型号锚定到了、但旁边数字不是目录档位（如 `PNME18` 的 `18`）→ 同样不锚定（尺寸没定死就不放过）；
6. 锚定不到的**保持现状**，进 `product_anchor_report.md` 的「待甲方确认清单」，绝不臆造。
