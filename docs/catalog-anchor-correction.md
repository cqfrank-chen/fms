# 产品目录更正报告（型号 = 基础型号 + 尺寸）

> 目标：按**甲方提供的 2026 版官方产品目录**（切割嘴 CUTTING NOZZLES）更正系统里的产品目录，
> 并把「取价 / 识单产品匹配」改成**基础型号相同 + size 相同**才算命中。
> 结论先行：
> **① 目录解析到 6 系列 / 37 型号 / 286 条「型号×size」，与目录自注完全一致，0 处解析疑难；**
> **② 1444 条产品档案锚定成功 1046 条（72.4%，其中 993 条 size 明确），未锚定 398 条一律保持现状并标记，未臆造一条；**
> **③ 本地空库跑真实管线实测：缺价行 1561 → 1391，报价补价 105 → 275，**解锁 170 行**，且未跨尺寸错配（跨尺寸命中 0 例）；**
> **④ 迁移只新增（products + 8 列 + 1 索引）；修正脚本幂等（复跑 0 行）；未 push、未碰云端。**

---

## 〇、甲方规则（本轮最高优先级）

> 型号名**前面或后面**跟的数字、或 **# 号后**的数字 = **同一型号的不同 size**（不是不同型号的写法变体）。

| 写法 | 解析结果 | 说明 |
| --- | --- | --- |
| `0-GPN` / `00-GPN` / `000-GPN` | 型号 **GPN**，size **0 / 00 / 000** | 三档不同尺寸（目录孔径 1.0 / 0.8 / 0.7），**各自独立档案** |
| `106 #1` / `106 1#` | 型号 **106**，size **1** | 前后两种写法等价 |
| `1-1-101` / `2-1-101` / `0-1-101` | 型号 **1-101**，size **1 / 2 / 0** | 型号前的数字是 size |
| `乙炔割嘴1-101-2` / `6290NX-2` / `MC-12-2#` | 型号 **1-101 / 6290NX / MC12**，size **2** | 型号后的数字是 size |
| `Victor 乙炔割嘴 1-1-101` | 同上 | **品牌 / 描述前缀不影响命中** |

**前导零逐字符比较**：0 ≠ 00 ≠ 000 ≠ 0000 —— 跨 size 一律不命中（价格错误代价高，宁缺勿错）。

---

## 一、把目录解析成机器可读的型号矩阵（任务一）

### 1.1 产物

| 文件 | 内容 |
| --- | --- |
| `tools/catalog/catalog_models.json` | 机器可读矩阵：`series[] → models[] → sizes[]`（含气体类型、孔径、厚度、页码、别名） |
| `tools/catalog/model_matrix.csv` | 逐「型号 × size」一行（**286 行**）＋表头，供人工核对 |
| `tools/catalog/catalog_parse_report.md` | 解析报告（逐系列 / 逐型号核对 + 无法解析部分） |
| `apps/api/src/ai/catalog-models.ts` | 服务端使用的**同一份数据**（由 `gen_server_catalog.mjs` 生成，禁止手抄） |
| `tools/catalog/parse_catalog.mjs` | 解析器（零依赖纯 Node，直接解析目录 HTML，无人工转录） |

### 1.2 实测核对（解析器输出，与目录自注逐项对照）

```
系列 6 个；型号 37 个；型号×size 286 行
  01  AMERICAN STYLE CUTTING TIP      20 型号 / 178 size 行
  02  JAPANESE STYLE CUTTING TIP       9 型号 /  48 size 行
  03  BRITISH STYLE CUTTING TIP        2 型号 /  15 size 行
  04  FRENCH STYLE CUTTING TIP         2 型号 /  14 size 行
  05  AUSTRALIAN STYLE CUTTING TIP     2 型号 /  15 size 行
  06  BRAZILIAN STYLE CUTTING TIP      2 型号 /  16 size 行
问题条目：0
```

| 指标 | 实测 | 目录自己标注 | 一致 |
| --- | --- | --- | --- |
| 系列数 | 6 | 封面「6 Styles / Series」、目录页 6 行 | ✅ |
| 型号数 | **37** | 封面「37 Models in total」、目录页 20+9+2+2+2+2=37 | ✅ |
| 逐系列型号数 | 20 / 9 / 2 / 2 / 2 / 2 | 目录页「Models」列 20 / 9 / 2 / 2 / 2 / 2 | ✅ |
| 气体类型 | 37/37 均取到 | 每张表下方 `<型号> FOR L.P.G` / `FOR ACE` | ✅ |
| 无法解析 | **0** | — | ✅ |

> 说明：甲方口径里写的「JAPANESE(10) / BRITISH(ANME,PNME,13)」中的 10 / 13 是**目录页码**，
> 不是型号数；目录页自注的型号数是 JAPANESE 9、BRITISH 2，合计 37 —— 与解析结果一致。

### 1.3 例：GPN 三档前导零（目录原文）

| size | orifice(mm) | thickness(mm) |
| --- | --- | --- |
| 000 | 0.7 | 1-3 |
| 00 | 0.8 | 3-6 |
| 0 | 1.0 | 6-10 |
| 1 | 1.2 | 10-20 |
| 2 | 1.5 | 20-40 |

---

## 二、更正系统产品目录（任务二）

### 2.1 schema 变更（**只新增**）

迁移：`apps/api/drizzle/0023_catalog_anchor.sql`（启动时自动执行，幂等）

| 新列 | 类型 | 含义 |
| --- | --- | --- |
| `catalog_model` | text | 目录**基础型号**（`1-101` / `GPN` / `6290NX` …）；null = 未锚定 |
| `size_spec` | text | 目录 **size setting**（`000` / `00` / `0` / `1` …，**前导零原样**）；null = 名称未写尺寸 |
| `series` | text | 系列 / 款式（`AMERICAN STYLE CUTTING TIP` 等） |
| `gas_type` | text | 目录气体类型 `LPG`（丙烷）/ `ACETYLENE`（乙炔） |
| `orifice_mm` | numeric | 切割孔径(mm)，取自目录该型号该 size 行 |
| `thickness_range` | text | 切割厚度范围(mm)，如 `6-10` |
| `catalog_anchor` | text | `matched` / `unmatched`（未锚定的保持现状并标记） |
| `catalog_note` | text | 锚定说明 / 未锚定原因（人工复核用） |

另新增索引 `products_catalog_model_size_idx (catalog_model, size_spec)`。
**不改既有列、不删列、不改枚举**；既有的 `type`（英式/美式×乙炔/丙烷）**原样不动** ——
目录按「款式」分 6 类（美式/日式/英式/法式/澳式/巴西式），既有枚举只覆盖英式/美式两族，无法承载。

### 2.2 锚定结果（1444 条产品档案）

| 指标 | 条数 | 占比 |
| --- | --- | --- |
| 产品档案总数 | 1444 | 100% |
| **锚定成功（matched）** | **1046** | **72.4%** |
| —— 其中 size 明确 | 993 | 68.8% |
| 未锚定（unmatched，保持现状并标记） | 398 | 27.6% |

| 未锚定原因 | 条数 |
| --- | --- |
| 型号未锚定到目录 | 224 |
| 型号边界不干净（右侧紧贴字母数字，多半是别的编号） | 87 |
| 尺寸不在目录档位（如 PNME18 的 18） | 56 |
| 尺寸有歧义（型号前后数字不同，如 `割嘴 1-GPN 2#`） | 31 |

| 系列分布（锚定成功的） | 条数 | | 气体分布 | 条数 |
| --- | --- | --- | --- | --- |
| AMERICAN | 784 | | LPG（丙烷） | 586 |
| JAPANESE | 75 | | ACETYLENE（乙炔） | 460 |
| BRAZILIAN | 53 | | **合计** | **1046** |
| AUSTRALIAN | 49 | | | |
| BRITISH | 43 | | | |
| FRENCH | 42 | | | |

**1173 条 `tbd`（待定）里有 812 条被目录锚定**（767 条连 size 都明确）→ 可据此填系列 / 气体类型，
不再需要人工逐条猜。另有 0 条「既有建议类型与目录气体冲突」。

### 2.3 锚定样例（真实数据）

| 产品名 | 解析结果 |
| --- | --- |
| `1-1-101` | 美式 / 型号 1-101 / size 1 / 乙炔 / ⌀1.2 / 厚 10-20 |
| `0-GPN` | 美式 / 型号 GPN / size 0 / 丙烷 / ⌀1.0 / 厚 6-10 |
| `00-GPN` | 美式 / 型号 GPN / size 00 / 丙烷 / ⌀0.8 / 厚 3-6 |
| `000-GPN` | 美式 / 型号 GPN / size 000 / 丙烷 / ⌀0.7 / 厚 1-3 |
| `割嘴 6290-1# 产品号码6010` | 美式 / 型号 6290 / size 1（`产品号码6010` 未被误当尺寸） |
| `HARRIS 丙烷割嘴6290-NX-0 53g` | 美式 / 型号 6290NX / size 0 |
| `smith 丙烷割嘴 SC-50-A-0 93g` | 美式 / 型号 SC50 / size 0 |
| `割嘴 1#-3-101 产品号码6019` | 美式 / 型号 3-101 / size 1 |
| `1503丙烷割嘴 #4 包装：塑料盒贴型号` | 巴西式 / 型号 1503 / size 4 / 丙烷 |
| `G1-P16/10` | 法式 / 型号 G1-P / size 16/10（分数档位） |

### 2.4 修正脚本（幂等 / dry-run / 只动 8 列）

`tools/catalog/apply_catalog_correction.mjs` —— 详见 `tools/catalog/README.md`。
本地实测（库 `fms_catalog`，1444 条真实档案）：

```
$ node tools/catalog/apply_catalog_correction.mjs --dsn <DSN>            # dry-run
  产品档案 1444；锚定成功 1046（size 明确 993）；未锚定 398；**需要修正的行数 1444**
  分列改动：catalog_model 1046 / size_spec 993 / series 1046 / gas_type 1046 /
            orifice_mm 993 / thickness_range 993 / catalog_anchor 1444 / catalog_note 451

$ node tools/catalog/apply_catalog_correction.mjs --dsn <DSN> --apply     # 正式写入
  UPDATE 影响行数合计 1444（目标 1444 行）
  复跑残留差异行数 0  ✅ 幂等
  写入后 catalog_anchor 分布：matched=1046  unmatched=398

$ 再跑一次 --apply                                                        # 幂等复核
  需要修正的行数 0；UPDATE 影响行数合计 0；复跑残留差异行数 0  ✅
```

---

## 三、用「基础型号 + 尺寸」改进匹配（任务三）

### 3.1 唯一权威实现

新增 `apps/api/src/ai/product-model.ts`（服务端）/ `tools/catalog/lib/product-model.mjs`（工具侧，**同算法双实现**）：

| 函数 | 作用 |
| --- | --- |
| `parseProductModel(name)` | 产品名 → `{series, model, size, gasType, orificeMm, thicknessRange}`（锚定不到 → null） |
| `sameCatalogProduct(a,b)` | **基础型号 + size 都相同**才算命中（两边都必须锚定到目录） |
| `findProductCandidates(name, archives)` | 档案候选唯一选法：① 名称完全相同 → ② 基础型号+size → ③ 子串容错（带数字指纹守卫） |
| `explainProductModel(name)` | 附「为什么没锚定」的中文原因（报告 / 排障） |

**四处调用点统一到同一实现**（此前各写各的，容易漂移）：

| 位置 | 改造 |
| --- | --- |
| `quotes/quote-pricing.ts` `matchQuoteProduct` | 新增 `catalogModel` 命中档；**同档内「文本命中」优先于「型号+尺寸命中」**（老口径结果不被改写）；`PriceHit` 新增 `matchKind`，文案标注「（基础型号+尺寸）」 |
| `ai/order-parser.service.ts`（识单产品匹配） | 改用 `findProductCandidates` |
| `orders/orders.service.ts`（落草稿产品匹配） | 同上 |
| `quotes/quotes.service.ts`（报价导入挂接产品） | 同上（沿用不做子串容错的老口径，仅新增型号+尺寸档） |

### 3.2 安全边界（写进代码注释与单测）

1. 型号必须锚定到**目录里真实存在的 37 个型号**之一（`106HC` / `PNM` / `W` 等目录外写法一律不认，退回老口径）；
2. size 必须**逐字符**命中该型号目录档位（0 / 00 / 000 三档互不顶替）；
3. 型号边界必须干净：右侧紧贴字母数字且不是合法 size → 作废（货号 `4154` 不会被当成型号 `41`、`1380` 不会被当成 `138` 的 size 0）；
4. 型号前后**同时**出现数字且不同 → 尺寸有歧义，**不出结论**（如 `割嘴 1-GPN 2#`）；
5. 型号认到了、旁边数字不是目录档位（`PNME18` 的 `18`）→ 同样不锚定（尺寸没定死就不放过）；
6. **不做无约束子串匹配去凑覆盖率**；多候选一律不自动选，交人工。

### 3.3 缺价解锁：本地空库实测前后对比（真实管线，不是估算）

**环境**：全新空库 `fms_catalog`（15433）→ 启动 API（自动跑迁移）→ 走既有接口导入
`products_candidates.csv` **1444 条产品** + `contract_price_seeds.csv` **2582 条报价** + 4 个客户档案。
**管线**：`POST /api/ai/orders/parse` 逐份识别 **277 份计划单切片**（`doc_csv_sz` 214 + `doc_csv_zh` 63），
统计「报价补价行 / 仍缺价行」（`tools/ziliao/draft_orders_from_parse.mjs --dry-run`）。

| 指标 | 改造前 | 改造后 | 变化 |
| --- | --- | --- | --- |
| 计划单产品行 | 1814 | 1814 | — |
| **报价命中补价行** | **105** | **275** | **+170（+161.9%）** |
| **仍缺价行** | **1561** | **1391** | **−170（−10.9%）** |
| 产品未建档行 | 26 | 26 | 0（未因改造丢失档案命中） |
| —— 嵊州海田（有报价覆盖） | 1489 行 / 补价 105 / 缺价 1240 | 1489 行 / 补价 275 / 缺价 **1070** | 缺价 −170 |
| —— 正恒公司（**无任何报价**） | 325 行 / 补价 0 / 缺价 321 | 325 行 / 补价 0 / 缺价 321 | 0（无价可补，如实保持待补） |

**结论**：本轮改造把「计划单写 `1-1-101`、合同写 `Victor 乙炔割嘴 1-1-101`」这类**写法差异**打通，
**实测解锁 170 行缺价**，且**一条都没有跨尺寸错配**（跨尺寸样例见 §四 单测 / e2e）。

**为什么不是 1522 行全部解锁（不臆造）**：
残余 1391 行缺价的主因是 **报价覆盖不到**（正恒公司 321 行整族没有报价；其余是报价种子未覆盖到的型号族），
不是匹配口径问题 —— 上轮报告的「跨客户价源（安宝合同 → 嵊州海田计划单）是否可作为通用价」属**业务裁定**，
仍需甲方给对照 / 裁定后才能落地，脚本不替甲方生成跨客户价。

> 关于任务书里提到的「**1264 行缺价**」：与本轮实测的**嵊州海田切片缺价 1240 行（改造前）**同源同量级；
> 本轮按**真实管线 + 全量 277 份切片**的口径复测，改造前是 **1561 行**，改造后 **1391 行**。

### 3.4 SQL 核对（`tools/catalog/catalog_anchor_audit.sql`，只读）

```
=== 1) 产品档案锚定计数 ===    matched 1046 / with_size 993 / models 28 ；unmatched 398
=== 1b) 总数核对 ===           total 1444 = matched 1046 + unmatched 398
=== 3) 前导零三档各自独立（GPN）===
  000 | LPG | 0.7 | 1-3    ／ 00 | LPG | 0.8 | 3-6  ／ 0 | LPG | 1.0 | 6-10
  1   | LPG | 1.2 | 10-20  ／ 2  | LPG | 1.5 | 20-40       ← 三档三行、孔径各不相同
=== 3b) 同一基础型号的不同 size 都是独立档案（1-101）===
  size_spec: 000(3) / 00(11) / 0(13) / 1(23) / 2(22) / 3(24) / 4(12) / 5(10) / 6(7) / 7(3) / 8(5)   ← 各自独立，未合并
```

（另有一节 `3c` 专门列出「同一型号同一尺寸存在多条档案」——那是产品档案里**不同包装/刻字的多种写法**
（上一轮报告的「A 类可合并候选」），**不影响锚定正确性**，但会影响「按型号+尺寸挑一条档案」的唯一性，
已写入待甲方确认清单。本地库里最常见的如 `GPN size 1` 有 28 条写法不同的档案。）

---

## 四、自测（全部真实执行）

### 4.1 单元测试 `npm test`（apps/api）

```
Test Suites: 21 passed, 21 total
Tests:       309 passed, 309 total
```

本轮新增 / 扩展：
* **新增 `src/ai/product-model.spec.ts`（25 项）**：目录矩阵 6 系列 / 37 型号 / 逐系列型号数；
  `0-GPN/00-GPN/000-GPN` 三档各自独立；`106 #1` / `106 1#`；`1-1-101/2-1-101/0-1-101/00#-3-101`；
  `G1-A/G1-P/G1-P16/10`、`1502/1503 #4`、`M(ACE) 1#`、`6290NX-2`、`MC-12-2#`、`SC-50-A-0`；
  **拒绝矩阵**：`0000-GPN` / `1380` / `4154` / `货号：4154` / `割嘴 1-GPN 2#` / `PNME18 割嘴 1/16` / `106HC-2` → 全部不锚定；
  `sameCatalogProduct` 品牌前缀可命中、跨 size 一律拒绝、一边没写尺寸不命中；
  `findProductCandidates` 三级优先级 + 多候选不自动选 + 整名数字指纹收窄。
* `src/quotes/quote-pricing.spec.ts`（30 项，扩展）：品牌前缀差异现在按「基础型号+尺寸」命中（`matchKind=catalogModel`、文案含「基础型号+尺寸」）；
  跨 size 绝不命中（`2-1-101` 不取 `1-1-101` 的价，但取「乙炔割嘴1-101-2」）；同档内文本命中优先于型号+尺寸命中。

### 4.2 端到端 e2e（真实 HTTP + 真实 PostgreSQL；**每个套件独立空库**）

```
quote-draft-e2e      通过 215 项，失败 0 项     （上一轮 197 项；本轮新增 18 项）
excel-order-e2e      通过 169 项，失败 0 项     （上一轮 161 项；本轮新增 8 项）
invoice-e2e          通过 142 项，失败 0 项
invoice-simple-e2e   通过  65 项，失败 0 项
invoice-red-e2e      通过 105 项，失败 0 项
```

本轮新增用例（要点）：
* `quote-draft-e2e`：建 `1-1-101` / `2-1-101` 两条独立档案；合同写法 `Victor 乙炔割嘴 1-1-101`（13.20）
  与 `乙炔割嘴1-101-2 82g 货号：4191`（15.00）各自建价；取价试算 `1-1-101`→13.20（`matchKind=catalogModel`、
  文案含「基础型号+尺寸」）、`2-1-101`→15.00、**`3-1-101` 保持缺价**；
  识单三行补价 2 行 / 缺价 1 行；品牌写法 → 档案 `1-1-101`；
  `0-GPN 0#`（同 size 写法差异）→ 命中档案 `0-GPN` 并补 8.50；**`0-GPN 2#`（前后尺寸冲突）→ 不错配、保持未建档**；
  `1-GPN` 无报价 → 保持缺价；SQL：`products` 新增 8 列、目录列为空（识单不自动写档案）、两条合同写法报价各自独立入库。
* `excel-order-e2e`：Excel/CSV 订单里写 `1-1-101` → 落档案 `1-1-101` 并补 13.20；同表 `2-1-101` 保持缺价；
  合同写法 `Victor 乙炔割嘴 1-1-101` 直接出现在表里同样命中。

### 4.3 构建与容器

```
apps/api  npm run build（nest build）          通过
apps/web  npm run build（tsc -b && vite build） 通过（仅 chunk >500kB 体积提示）
docker compose up -d --build                    镜像重建成功
  fms-nginx | Up | 0.0.0.0:80->80/tcp
  fms-app   | Up | 3000/tcp
  fms-app   日志 ERROR 行数 = 0
  fms-nginx 日志 ERROR 行数 = 0
  GET http://127.0.0.1/api/health → {"status":"ok","db":"up"}
  容器内迁移已应用：products 的 8 个新列齐全
```

### 4.4 双实现一致性（防口径漂移）

```
$ node tools/catalog/verify_parity.mjs
双实现一致性校验：共 1525 个名称，一致 1525，不一致 0
（工具侧 lib/product-model.mjs ↔ 服务端 dist/ai/product-model.js）
```

---

## 五、云端修正命令（**由甲方执行；本轮未连云端、未做任何云端写操作**）

前置：容器/服务重启后会自动跑迁移 `0023_catalog_anchor.sql`（只新增 8 列 + 1 索引），无需手工建表。

```powershell
# ① 只读核对（先确认迁移已生效、锚定前后的计数基线）
psql "postgresql://fms:<密码>@<云端主机>:5432/fms" -v ON_ERROR_STOP=1 -f tools/catalog/catalog_anchor_audit.sql
#    或容器内：docker cp tools/catalog/catalog_anchor_audit.sql fms-postgres:/tmp/a.sql
#              docker exec -i fms-postgres psql -U fms -d fms -f /tmp/a.sql

# ② dry-run（只报告，不写库）—— 期望：产品档案 1444；锚定成功 1046；未锚定 398；需要修正 1444 行
node tools/catalog/apply_catalog_correction.mjs --dsn "postgresql://fms:<密码>@<云端主机>:5432/fms"

# ③ 确认无误后正式写入（单事务、逐行参数化 UPDATE、失败自动回滚）
node tools/catalog/apply_catalog_correction.mjs --dsn "postgresql://fms:<密码>@<云端主机>:5432/fms" --apply
#    期望：UPDATE 影响行数合计 1444；复跑残留差异行数 0（幂等）；matched=1046 / unmatched=398

# ④ 复核（复跑 ② 应显示「需要修正的行数 0」）
node tools/catalog/apply_catalog_correction.mjs --dsn "postgresql://fms:<密码>@<云端主机>:5432/fms"
```

> 脚本自带硬约束：只 `select` / `update products`，只写那 8 列；**不改 name、不改 type、不新增/删除行、不合并任何 size**。

---

## 六、待甲方确认清单（脚本**不臆造**，一律保持现状 + 标记）

未锚定 398 条聚合出的主要「型号族」（完整清单见 `tools/catalog/product_anchor_report.md` §三 与 `product_anchor.csv`）：

| # | 型号族（疑似） | 条数 | 样例 | 需要甲方确认什么 |
| --- | --- | --- | --- | --- |
| 1 | `1-GPN` 前后数字并存 | 7 | `割嘴 1-GPN 2# 产品号码6028` | 前导 1 与 # 后 2 哪个是 size？（脚本按「歧义」拒绝） |
| 2 | `106HC` | 28 | `106HC-2` / `KOIKE 106HC 割嘴 83克 5#` | 目录有 106（KOIKE 日式）；`106HC` ≡ `106` 还是独立型号？ |
| 3 | `102HC` | 14 | `102HC-3` | 同上（目录有 102） |
| 4 | `PNME18` / `PNME9` | 34 | `PNME18 割嘴 1/16` / `PNME9 1/32` | 后缀 18 / 9 是什么含义？（目录 PNME 只有分数档位；18 不是档位） |
| 5 | `ANM` / `PNM` | 19 | `乙炔割嘴 ANM 1#` / `外嘴 PNM 1#` | 是否即目录 `ANME` / `PNME` 的简写（缺 E）？ |
| 6 | `W` 族 | 12 | `1-W` `2-W` `0-W` `3-W焊杆` | 是否属于切割嘴目录范围？目录没有 W 族 |
| 7 | `MFA` / `MFN` | 24 | `2-MFA` `8-MFN` | 加热/钎焊系列，本期 6 系列 37 型号目录不含 —— 是否另有目录？ |
| 8 | `6290VVC` | 14 | `6290VVC` | 目录有 6290 / 6290AC / 6290NX / 6290NFF，没有 VVC |
| 9 | `GPP` | 2 | `0-GPP` `1-GPP` | 目录有 GPN（丙烷）；GPP 是另一型号？ |
| 10 | `Nozzle №1 (3/64”)` 类 | 11 | `Nozzle №1 (3/64”) 客人要12个槽 74克` | 括号里的分数是否就是目录 size？型号名是什么？ |
| 11 | 纯描述无型号 | 30+ | `丙烷切割喷嘴,1号 厚度：10-20mm孔口：1.2` / `尼龙袋` | 只有描述/包装、没有型号 —— 是否属于产品档案？ |
| 12 | 同一型号同一尺寸多条档案 | 涉及 1046 条中的多组 | `GPN size 1` 有 28 种写法 | 是否按上一轮报告的「A 类」合并这些包装/刻字写法？（脚本**不自动合并**） |

---

## 七、改动清单（**本地 commit；未 push、未触碰云端 47.114.92.228**）

服务端：
* 新增 `apps/api/src/ai/product-model.ts`（同算法双实现的服务端侧；含 `findProductCandidates`）；
* 新增 `apps/api/src/ai/catalog-models.ts`（**脚本生成**的目录数据）；
* 新增 `apps/api/src/ai/product-model.spec.ts`（25 项）；
* `apps/api/src/quotes/quote-pricing.ts`（`catalogModel` 命中档 + `matchKind` + 同档优先级）、`quote-pricing.spec.ts`；
* `apps/api/src/ai/order-parser.service.ts`、`apps/api/src/orders/orders.service.ts`、`apps/api/src/quotes/quotes.service.ts`（产品候选统一到同一实现）；
* `apps/api/src/db/schema.ts`（+8 列的列定义）、`apps/api/drizzle/0023_catalog_anchor.sql` + `meta/0023_snapshot.json` + `_journal.json`；
* `apps/api/test/quote-draft-e2e.mjs`（+18 项）、`apps/api/test/excel-order-e2e.mjs`（+8 项）。

工具：
* 新增 `tools/catalog/`：`parse_catalog.mjs`、`gen_server_catalog.mjs`、`analyze_product_anchor.mjs`、
  `apply_catalog_correction.mjs`、`verify_parity.mjs`、`catalog_anchor_audit.sql`、`lib/product-model.mjs`、`README.md`；
  产物 `catalog_models.json`、`model_matrix.csv`、`catalog_parse_report.md`、`product_anchor.csv`、`product_anchor_report.md`。

文档：本报告 `docs/catalog-anchor-correction.md`。

---

## 八、遗留与建议

1. **未锚定 398 条**必须甲方逐族确认（§六），其中最值钱的是 `106HC` / `102HC`（42 条档案，出现次数很高）
   与 `ANM` / `PNM`（19 条）—— 一旦确认，可再解锁一批缺价；
2. **同一型号同一尺寸的多条档案**（包装/刻字写法差异）建议按上一轮的 A 类清单合并，否则「按型号+尺寸挑一条档案」
   只能靠整名数字指纹收窄，遇到同尺寸多种写法时仍需人工；
3. **跨客户价源是否可作为通用价**（安宝合同 → 嵊州海田计划单）是业务裁定，脚本不代裁；正恒公司 321 行缺价的
   根本原因是该客户没有任何报价；
4. 目录若有新版（改尺寸档位 / 新增型号），流程是：重跑 `parse_catalog.mjs` → `gen_server_catalog.mjs` →
   `npm run build` → 重跑 `analyze_product_anchor.mjs` 与 `apply_catalog_correction.mjs`（幂等）；
   `verify_parity.mjs` 会挡住两边算法漂移；
5. 报告里的「云端修正命令」需甲方在**有迁移 0023 之后**执行；本轮所有数字均产自本地空库 / 本地容器，未连云端。
