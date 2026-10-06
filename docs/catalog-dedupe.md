# 产品目录去重合并（同型号同 size）+ 类型以目录为准 + 列表按系列排序与筛选

> 目标：按**甲方提供的 2026 版官方产品目录**（6 系列 / 37 型号 / 286 条型号×size）把系统里的产品档案
> **去重合并**（同一「基础型号 + size」的多种写法合成一条），**类型一律以目录为准**，
> 产品列表**按系列分组排序**并新增筛选。
>
> 结论先行：
> **① 1444 条真实档案（+1 条占位 = 1445）按「(基础型号, size)」分成 191 组，其中 145 组多于一条 → 合并掉 802 条，剩 643 条；**
> **② 重挂 8 张引用 products 的外键共 2608 行（订单行 1012 + 报价 1596），删除冲突重复行 0 行；合并后 8 张表悬空引用 0、同型号同 size 重复组 0；**
> **③ 类型以目录为准：可判定的 827 条 matched 档案里 593 条由 tbd 修正为具体类型；合并后现存 244 条 matched 档案中 171 条类型具体、73 条保持 tbd（款式枚举承载不了，不臆造）；**
> **④ 列表默认按系列（官方目录顺序）分组排序（无系列排最后），新增 系列 / 气体类型 / 锚定状态 / 关键词 四个筛选，筛选状态保留在地址栏；**
> **⑤ 默认 dry-run + 单事务 + 幂等（复跑 0 更新 / 0 删除 / 残留差异 0）；单测 13、e2e 38、回归 215/169/142/65/105 全绿，未 push、未触碰云端。**

---

## 〇、甲方规则（本轮最高优先级）

> **同一型号的不同写法要合并**：型号前后带的数字、或 # 号后的数字表达的是 **size**；
> 例如 **`0-1-101` 与 `1-101 割嘴 0#` 是同一型号同一尺寸**（型号 1-101、size 0）。
> **但 `0` / `00` / `000` 是不同 size，绝不合并**（数字指纹逐字符一致）。

| 写法 | 解析结果 | 是否同一产品 |
| --- | --- | --- |
| `0-1-101` / `1-101 割嘴 0#` / `1-101 size0` / `1-101 size 0` / `1-101 0#` / `1-101 #0` / `1-101-0` | 型号 **1-101**，size **0** | ✅ **同一条**（本轮合并） |
| `00-1-101` / `1-101 size00` | 型号 **1-101**，size **00** | ❌ 与 size 0 不同产品 |
| `000-1-101` | 型号 **1-101**，size **000** | ❌ 与 size 0 / 00 都不同 |
| `1-101 #1` / `1-101 1#` | 型号 **1-101**，size **1** | ❌ 与 #0 不同产品 |
| `0-GPN` / `00-GPN` / `000-GPN` | 型号 **GPN**，size **0 / 00 / 000** | ❌ 三档各自独立（各自合并成一条） |

新增支持：**「size」二字显式标注**的第三种写法（`1-101 size0` / `1-101 size 0` / `GPN size #1`）——
工具侧 `tools/catalog/lib/product-model.mjs` 与服务端 `apps/api/src/ai/product-model.ts` **两份实现同步新增**，
由 `verify_parity.mjs` 逐条比对（1525 个名称 0 差异）。取到的数字仍必须**逐字符命中该型号的目录档位**，
否则整个候选作废（`1-101 size 9` / `1-101 size 99` → 不锚定，绝不猜）。

---

## 一、去重合并（任务一）

### 1.1 判定与分组

| 环节 | 口径 |
| --- | --- |
| 型号 | 必须锚定到官方目录 37 个型号之一（沿用既有安全口径：边界干净、不做无约束子串匹配） |
| size | 逐字符等于该型号的目录档位（`0 ≠ 00 ≠ 000`）；名字没写 size → **不参与合并** |
| 分组键 | `(catalog_model, size)` —— 组内任一成员都是「同一产品」 |
| 不参与合并 | 型号未锚定目录、或名字未写 size 的档案 → **保持现状**，只列清单（见 §五 待甲方确认） |

### 1.2 存活记录选择规则（固定、可复算、不随机）

1. **优先 `catalog_anchor = matched`** —— 本脚本只对「matched + size 明确」的组做合并，组内天然全 matched；
2. **其次「字段最全」**：完整度打分 = 类型具体（非 tbd）**+2** / 默认包装 **+1** / 默认工序路线 **+1** / 安全库存 > 0 **+1**；
3. **其次 id 最小**（最早建档）。

**不丢信息**：存活记录为空的 默认包装 / 默认工序路线 从被合并记录里按 id 升序补齐；安全库存取组内最大值。
被合并的写法（id + 原始名字）全部写入：
* 存活记录的 `catalog_note`：`已合并同一「型号+尺寸」的 N 条档案（#a、#b…），存活 #s；目录：<型号> size <size>`
* 存档 CSV：`tools/catalog/dedupe_product_merges.csv`（**802 行**，含分组键 / 系列 / 气体 / 类型 / 存活 id+名字 / 被合并 id+名字）

### 1.3 命名口径（**不臆造**）

* 目录对产品的命名 = `catalog_model` + `size_spec`，这两列**一律以目录为准**；
* 显示名 `name` **保留存活记录原文** —— 甲方原始写法里带「包装 / 刻字 / 重量 / 货号」等**目录里没有的信息**，
  改名会把这些信息抹掉。若甲方要求统一改成目录标准名（`1-101 0#` 这种形式），
  脚本已备好开关 `--canonical-name`（**默认关闭**），确认后再用。

### 1.4 重挂引用（必须做，脚本自动完成）

引用 `products` 的外键**运行时从 `information_schema` 查真实清单**（不写死表名）：

| 表 | 处理 |
| --- | --- |
| `order_lines` / `plan_sheet_lines` / `goods_receipt_lines` / `outbound_lines` / `stocktakes` / `product_quotes` | 直接 `update … set product_id = 存活记录` |
| `inventory`（唯一键 `(product_id, batch_no)`） | 先重挂**不撞唯一键**的行，再删除被合并记录里剩下的（同批次重复行），逐条计数上报 |
| `product_processes`（唯一键 `(product_id, process_id)`） | 同上（同工序重复行） |

「同一订单出现同产品的多行」检查：本地库 **171 张订单**属于此形态 —— 这是**业务上允许**的
（同一订单里同产品不同刻字 / 包装分行），重挂**不会新增订单行**，脚本只检查并报告，不擅自合并订单行。

### 1.5 dry-run / apply / 幂等

* **默认 dry-run**（只报告不写库）；`--apply` 才写库；
* **单事务**：任一步失败立即 rollback（本轮实测触发过一次参数编号错误，库确实**零改动**被回滚）；
* **幂等**：目标值是「产品名 + 目录」的纯函数结果，第二次跑差异必然 0（apply 后脚本自带自校验）。

---

## 二、类型以目录为准（任务二）

| 来源 | 映射 |
| --- | --- |
| 目录气体标注 | `FOR L.P.G` → `gas_type = LPG`；`FOR ACE` → `gas_type = ACETYLENE`（甲方口径 ACE→ACETYLENE） |
| 目录款式（系列）+ 气体 → `type` | 美式 AMERICAN + 乙炔 → `us_acetylene`；美式 + 丙烷 → `us_propane`；英式 BRITISH + 乙炔 → `uk_acetylene`；英式 + 丙烷 → `uk_propane` |
| 映射不到既有枚举 | 日式 / 法式 / 澳式 / 巴西式（既有枚举只有英式/美式 × 乙炔/丙烷）→ **保持 `tbd` 并标记**，**不臆造** |
| 未锚定目录的档案 | **不改 type**（保持现状：既不臆造具体类型，也不把既有值擅自降级成 tbd） |

类型严格按目录判定，**与名字里出现「乙炔 / 丙烷」字样无关**（例：名字写「丙烷割嘴 1-101 1#」，
但目录 1-101 是 AMERICAN + ACE → `us_acetylene`）。单测覆盖了这一点。

---

## 三、列表按系列排序 + 新增筛选（任务三）

### 3.1 后端（`GET /api/products`）

| 参数 | 说明 |
| --- | --- |
| `series` | 目录系列 / 款式（精确匹配） |
| `gasType` | `LPG` / `ACETYLENE`（兼容写法 `ACE`） |
| `anchor` | `matched`（已锚定）/ `unmatched`（未锚定） |
| `kw` | 关键词（产品名 / 基础型号 / size / 系列 模糊匹配，与上面三个筛选是 AND） |
| `includePlaceholders` | 既有：占位档案开关（不变） |

**返回顺序固定**：系列（**官方目录顺序** 01 AMERICAN → 02 JAPANESE → 03 BRITISH → 04 FRENCH →
05 AUSTRALIAN → 06 BRAZILIAN；**无系列排最后**）→ 组内 基础型号 → size → id。
实测系列出现顺序：`AMERICAN → JAPANESE → BRITISH → FRENCH → AUSTRALIAN → BRAZILIAN →（无系列）`，切换 6 次（正好 7 段）。

### 3.2 前端（设置 · 主数据 → 产品目录）

* **列**：产品名 / **型号(catalog_model)** / **size(size_spec)** / **系列** / **气体(ACE·LPG)** / **类型** /
  **锚定**（已锚定 / 未锚定 Tag）/ 默认包装 / 默认工序路线 / 安全库存 / 更新时间（列宽固定 + 横向滚动，不再挤压换行）；
* **筛选**：系列（目录 6 款式）/ 气体类型（LPG·ACE）/ 锚定状态（已锚定 / 未锚定）三个下拉
  + 关键词搜索框（产品名 / 型号 / size / 系列）+ 「重置筛选」；
* **筛选状态保留在地址栏**（`?series=…&gas=…&anchor=…&kw=…`）：刷新 / 分享链接后筛选不丢
  （本应用是极简 pathname 路由，只 `replaceState` 改 query，不影响路由）；
* 与既有「显示占位档案」开关并存；风格沿用既有 AntD 页面（Space/Select/Input.Search）。

---

## 四、本地库实测（真实执行，命令与输出）

**环境**：全新空库 `fms_dedupe2`（宿主 15433）→ 启动 API 自动跑迁移 → 导入
**1444 条产品**（`products_candidates.csv` 同源）+ **2582 条报价** + 4 个客户 →
再走**真实识单管线**（`POST /ai/orders/parse` → `POST /orders/draft`）落 **277 份草稿**（**1844 条订单行**）。
（另由识单惰性产生 1 条占位产品 → 库内共 1445 条档案。）

### 4.1 dry-run

```powershell
node tools/catalog/dedupe_products.mjs --dsn "postgres://fms:fms@localhost:15433/fms_dedupe2"
```

```
=== 一、扫描与分组 ===
  产品档案总数              1445
  目录锚定成功（matched）   1046（其中 size 明确 993）
  —— matched 但未写尺寸     53（保持现状，不猜 size）
  —— 未锚定（unmatched）    399（保持现状）
  可合并分组（matched+size）191 组
  —— 组内 >1 条的组         145 组（涉及 802 条待合并档案）
  —— 组内 =1 条的组         46 组（无需合并）
  合并前档案数              1445
  合并后档案数（预计）      643（减少 802）

=== 二、重挂引用（引用 products 的外键） ===
  goods_receipt_lines  重挂      0 行   引用列 product_id
  inventory            重挂      0 行   引用列 product_id
  order_lines          重挂   1012 行   引用列 product_id
  outbound_lines       重挂      0 行   引用列 product_id
  plan_sheet_lines     重挂      0 行   引用列 product_id
  product_processes    重挂      0 行   引用列 product_id
  product_quotes       重挂   1596 行   引用列 product_id
  stocktakes           重挂      0 行   引用列 product_id
  合计：重挂 2608 行，删除冲突重复行 0 行
  同一订单出现同产品的行检查：171 张订单（业务上允许：同产品不同刻字/包装分行；重挂不新增订单行）。

=== 三、类型以目录为准（matched 行） ===
  需要改 type 的档案        122
    tbd -> us_propane            67
    tbd -> us_acetylene          31
    tbd -> uk_acetylene          13
    tbd -> uk_propane            11

=== 四、目录列差异 ===
  catalog_model 0 / size_spec 0 / series 0 / gas_type 0 / orifice_mm 0 / thickness_range 0
  catalog_anchor 1（占位产品兜底标记） / type 122 / 存活记录字段补齐 3
```

### 4.2 合并样例（真实数据）

| 分组 | 存活记录 | 被合并（部分） |
| --- | --- | --- |
| `GPN 1` | **#6 `GPN-1`** | #18 `1-GPN`、#56 `丙烷割嘴 GPN-1 71g 代码：4193`、#91 `GPN 割嘴 1#`、#140 `割嘴 GPN #1 塑料盖贴：GPN-1`、#642 `victor 丙烷割嘴 GPN－1# …`（共 27 条并入） |
| `GPN 2` | **#7 `GPN-2`** | #10 `2-GPN`、#52 / #101（71g 两种写法）、#111 `割嘴 GPN #2 仿包装`（共 27 条并入） |
| `MC12 1` | **#9 `割嘴 MC-12-1# 产品号码6003`** | #1314 `MC12 割嘴 1#` |
| `SC12 2` | **#11 `割嘴 SC-12-2# 产品号码6001`** | #36 / #73（smith 103g 两种写法）、#209、#434、#629、#632（共 11 条并入） |

### 4.3 apply（单事务）

```powershell
node tools/catalog/dedupe_products.mjs --dsn "<DSN>" --apply
```

```
=== 写入完成 ===
  products 更新行数         268
  products 删除行数         802（目标 802）
  引用重挂行数合计          2608
  唯一约束冲突删除行数      0
  type 写入行数             267
  products 现有行数         643
  复跑残留差异行数          0  ✅ 幂等（第二次跑应改 0 行）
  仍有多条的合并组          0  ✅ 全部（型号+尺寸）唯一
  catalog_anchor 分布：matched=244  unmatched=399
  被合并清单已写出：tools/catalog/dedupe_product_merges.csv（802 行）
```

### 4.4 SQL 核对（`tools/catalog/dedupe_audit.sql`，只读）

```powershell
Get-Content tools/catalog/dedupe_audit.sql -Raw | docker exec -i fms-ziliao-pg psql -U fms -d fms_dedupe2 -v ON_ERROR_STOP=1 -f -
```

```
=== 1) 计数 ===   products 643｜order_lines 1844（不变）｜product_quotes 2582（不变）｜其余 0
=== 2) 悬空引用 === 8 张引用表全部 0 行
=== 3) 同一「型号 + size」仍多条 === 0 行
=== 4) 不同 size 仍各自独立 ===
   1-101 | 0   | 1 | #81 乙炔割嘴1-101 0# 产品号码6023
   1-101 | 00  | 1 | #166 乙炔割嘴1-101 00# 产品号码6022
   1-101 | 000 | 1 | #1144 乙炔割嘴 1-101 #000 84.5g
   GPN   | 0   | 1 | #46 0-GPN      GPN | 00 | 1 | #77 00-GPN      GPN | 000 | 1 | #448 000-GPN
=== 5) 系列 × 气体 × 类型（matched 244 条）===
   AMERICAN + ACETYLENE → us_acetylene 61 ／ AMERICAN + LPG → us_propane 81
   BRITISH  + ACETYLENE → uk_acetylene 13 ／ BRITISH  + LPG → uk_propane 16
   JAPANESE / FRENCH / AUSTRALIAN / BRAZILIAN（乙炔 + 丙烷）→ tbd 24 / 15 / 9 / 25
=== 6) 目录列填充率 === 643 条｜有型号 244｜有尺寸 191｜已锚定 244｜未锚定 399｜类型待定 435｜合并存活记录 145
=== 7) 未合并清单 === 型号未锚定 399｜名称未写 size（型号已锚定）53
```

### 4.5 复跑 --apply（幂等）

```
  products 更新行数 0 ／ products 删除行数 0 ／ 引用重挂行数合计 0 ／ 唯一约束冲突删除行数 0
  复跑残留差异行数 0 ✅ ／ 仍有多条的合并组 0 ✅ ／ products 现有行数 643
```

### 4.6 类型填充统计

| 指标 | 条数 |
| --- | --- |
| 合并前 matched 中「类型待定」 | 812 |
| 目录可判定类型的 matched 档案（美式 784 + 英式 43） | **827** |
| —— 其中由 tbd **修正为具体类型** | **593** |
| —— 原本已是正确类型（未改动） | 234 |
| 款式枚举承载不了（日 / 法 / 澳 / 巴西式） | 219（合并后现存 73） |
| 合并后现存 643 条里「类型待定」 | **435** = 未锚定 362 + 款式承载不了 73 |

---

## 五、自测（全部真实执行）

### 5.1 单元测试

```
$ node --test tools/catalog/dedupe_products.test.mjs
ℹ tests 13   ℹ pass 13   ℹ fail 0
   写法等价：0-1-101 ≡ 1-101 割嘴 0# ≡ 1-101 size0 ≡ 1-101 #0 ≡ 1-101-0
   00-1-101 ≠ 0-1-101；000-1-101 ≠ 00-1-101；1-101 #1 ≠ #0
   0-GPN / 00-GPN / 000-GPN 三档不同组；未锚定 / 未写 size / size 不在档位 → 不参与合并
   分组正确性（合成数据 + **真实 1444 条产品名**：191 组 / 145 组多条 / 802 条待合并 / 合并后 642）
   存活记录选择（完整度 → id 最小）；类型推导（美式/英式 → 具体；日/法/澳/巴西式 → tbd）

$ npm test（apps/api）
Test Suites: 21 passed, 21 total
Tests:       310 passed, 310 total        （309 → 310：新增 product-model.spec.ts 的「size」写法用例）
```

### 5.2 去重端到端（真实 PostgreSQL + 真实去重脚本）

```
$ node apps/api/test/dedupe-products-e2e.mjs
通过 38 项，失败 0 项
   · 写法等价合并（3 种写法 → 1 条；size 00 保持独立；未锚定 / 未写 size 保持现状）
   · 重挂引用正确性（订单行 2 / 报价 2 / 库存 1 / 工序 1；**唯一约束冲突行按设计删除 1+1 并计数**）
   · 8 张引用表悬空引用 0；幂等（复跑 0 更新 / 0 删除 / 残留 0）
```

### 5.3 回归（每个套件独立空库 + 真实 HTTP）

```
quote-draft-e2e      通过 215 项，失败 0 项
excel-order-e2e      通过 169 项，失败 0 项
invoice-e2e          通过 142 项，失败 0 项
invoice-simple-e2e   通过  65 项，失败 0 项
invoice-red-e2e      通过 105 项，失败 0 项

$ node tools/catalog/verify_parity.mjs
双实现一致性校验：共 1525 个名称，一致 1525，不一致 0

$ npm run build（apps/api，nest build）            通过
$ npm run build（apps/web，tsc -b && vite build）  通过（仅 chunk >500kB 体积提示）
```

### 5.4 容器（`docker compose up -d --build`）

```
 Image fms-app:local Built / Image fms-nginx:local Built
 Container fms-postgres Running（Healthy）
 Container fms-app Recreated → Started
 Container fms-nginx Recreated → Started

$ docker ps
 fms-nginx    Up   0.0.0.0:80->80/tcp
 fms-app      Up   3000/tcp
 fms-postgres Up (healthy)

$ curl -s http://127.0.0.1/api/health
 {"status":"ok","db":"up","time":"…"}

$ docker logs fms-app   | Select-String ERROR → 0
$ docker logs fms-nginx | Select-String ERROR → 0

$ 容器内实测新接口（登录后）
 GET /api/products → 200，返回结构含 catalogModel / sizeSpec / series / gasType / catalogAnchor
 GET /api/products?anchor=matched / ?gasType=ACE / ?kw=GPN → 全部 200
 （本地容器库只有 4 条布局测试档案，故筛选计数为 0，属预期）
```

> 说明：`docker compose up -d --build` 在 PowerShell 里用 `Tee-Object` 包装时退出码可能显示 1 ——
> 那是 docker 把构建进度写到 **stderr** 触发的 `NativeCommandError` 噪音；容器实际全部重建并 Up
> （上面的 `docker ps` / `/api/health` / 日志 ERROR=0 都是同一条命令之后立刻取的实测结果）。

### 5.5 接口实测（本地库 fms_dedupe2，合并后）

```
GET /api/products                     → 642 条（默认隐藏占位档案）
系列出现顺序 → AMERICAN → JAPANESE → BRITISH → FRENCH → AUSTRALIAN → BRAZILIAN →（无系列）
GET /api/products?series=AMERICAN…    → 142 条
GET /api/products?gasType=LPG         → 145 条      ?gasType=ACE → 99 条
GET /api/products?anchor=matched      → 244 条      ?anchor=unmatched → 398 条
GET /api/products?kw=GPN              →  39 条      ?kw=1-101 → 16 条
GET /api/products?series=AMERICAN&gasType=LPG → 81 条
```

---

## 六、云端执行命令（**由甲方执行；本轮未连云端、未做任何云端写操作**）

```powershell
# ⓪ 先备份（务必）
docker exec fms-postgres pg_dump -U fms -d fms -Fc -f /tmp/fms_before_dedupe.dump
docker cp fms-postgres:/tmp/fms_before_dedupe.dump ./fms_before_dedupe.dump

# ① 只读基线核对（确认目录列已就位、看清合并前的计数）
psql "postgresql://fms:<密码>@<云端主机>:5432/fms" -v ON_ERROR_STOP=1 -f tools/catalog/dedupe_audit.sql

# ② dry-run（只报告，不写库）—— 期望：产品档案 1445；matched 1046；145 组多条；预计合并 802 条 → 643 条
node tools/catalog/dedupe_products.mjs --dsn "postgresql://fms:<密码>@<云端主机>:5432/fms"

# ③ 确认无误后正式写入（单事务、失败自动回滚）
node tools/catalog/dedupe_products.mjs --dsn "postgresql://fms:<密码>@<云端主机>:5432/fms" --apply
#    期望：products 更新 268 / 删除 802；引用重挂 2608（订单行 1012 + 报价 1596）；
#          复跑残留差异 0；仍有多条的合并组 0；matched=244 unmatched=399

# ④ 幂等复核（复跑 ③ 应显示 0 更新 / 0 删除 / 残留 0）
node tools/catalog/dedupe_products.mjs --dsn "postgresql://fms:<密码>@<云端主机>:5432/fms" --apply

# ⑤ 合并后只读核对（条数 / 悬空引用 / 同型号同 size 只剩 1 条 / 前导零三档 / 类型分布）
psql "postgresql://fms:<密码>@<云端主机>:5432/fms" -v ON_ERROR_STOP=1 -f tools/catalog/dedupe_audit.sql
```

> **顺序说明**：本脚本**自包含**——即使云端还没跑过 `apply_catalog_correction.mjs`，
> 它也会把目录列（catalog_model / size_spec / series / gas_type / orifice_mm / thickness_range /
> catalog_anchor / catalog_note）与 `type` 按目录一次写全。
> 但**合并之后不要再跑 `apply_catalog_correction.mjs`**：它会把存活记录上的「合并说明」（catalog_note）覆盖回去。
> 容器/服务重启会自动跑迁移（本轮的改动**不含新迁移**，无需额外建表/改列）。
> **建议在业务低峰执行**（脚本单事务、期间会锁 products 相关行）。

---

## 七、待甲方确认清单（脚本**不臆造**，一律保持现状 + 标记）

| # | 事项 | 规模 | 需要甲方确认什么 |
| --- | --- | --- | --- |
| 1 | **未锚定目录的产品档案** | **399 条** | 与目录型号的对应关系（完整清单见 `tools/catalog/product_anchor_report.md` §三 与 `product_anchor.csv`）；主要型号族：`106HC`/`102HC`（42 条）、`ANM`/`PNM`（19 条）、`W` 族、`MFA`/`MFN`（24 条）、`6290VVC`（14 条）、`GPP`、`Nozzle №N (3/64”)` 等 |
| 2 | **型号已锚定但名字没写 size** | **53 条** | 如 `3-GPN`、`乙炔割嘴 1-101`、`丙烷割嘴 G1-P 单只重78g`、`G1-P 割`… —— 是否对应某个默认档位？（脚本**不猜 size**，故未参与合并） |
| 3 | **日 / 法 / 澳 / 巴西式的 `type` 保持 `tbd`** | 合并后 **73 条**（合并前 219 条） | 系统 `product_type` 枚举只有「英式/美式 × 乙炔/丙烷」。是否扩展枚举（如 `jp_*` / `fr_*` / `au_*` / `br_*`）？确认后可一次性按目录回填 |
| 4 | **显示名是否统一改为目录标准名** | 145 条存活记录（可选） | 目录标准名形如 `1-101 0#`。改名会**丢掉**原写法里的包装 / 刻字 / 重量 / 货号信息；如确认要改：`--canonical-name`（已有开关，默认关闭） |
| 5 | **是否加唯一索引防再次重复** | 建议 | `create unique index … on products(catalog_model, size_spec) where catalog_anchor='matched' and size_spec is not null`；本轮**未加**（怕影响既有导入流程），需要甲方点头 |
| 6 | **同一订单出现同产品的多行** | 171 张订单 | 属业务形态（同产品不同刻字/包装分行）；是否需要在下计划单前合并成一行？**脚本不代裁** |
| 7 | **存活记录选择规则** | 145 组 | 规则 = 完整度（类型具体 +2 / 包装 +1 / 路线 +1 / 有安全库存 +1）→ id 最小。逐组「存活 vs 被合并」明细见 `tools/catalog/dedupe_product_merges.csv`；如甲方希望指定某些组的存活记录，可给 id 清单再跑 |
| 8 | **重挂后报价/订单的含义** | 2608 行 | 被合并档案的报价与订单行已改指存活记录（**报价行本身没删**，历史价格与来源都在）；请确认后续取价按存活记录聚合符合预期 |

---

## 八、改动清单（**本地 commit；未 push、未触碰云端 47.114.92.228**）

**新增（工具）**
* `tools/catalog/dedupe_products.mjs` —— 去重合并 CLI（dry-run / 单事务 / 重挂外键 / 幂等 / 报告）
* `tools/catalog/lib/dedupe-core.mjs` —— 纯函数核心（解析 → 分组 → 选存活记录）
* `tools/catalog/lib/catalog-type.mjs` —— 目录（系列 + 气体）→ `type` 推导
* `tools/catalog/dedupe_products.test.mjs` —— 去重判定单测（13 项）
* `tools/catalog/dedupe_audit.sql` —— 合并后只读核对 SQL
* `tools/catalog/dedupe_product_merges.csv` —— 被合并清单存档（802 行）

**新增（服务端测试）**
* `apps/api/test/dedupe-products-e2e.mjs` —— 去重端到端自测（38 项）

**修改**
* `tools/catalog/lib/product-model.mjs` + `apps/api/src/ai/product-model.ts` —— 新增「size 二字显式标注」写法（两份实现同步）
* `apps/api/src/ai/product-model.spec.ts` —— 新增该写法的守门用例（含 `size 9` 必须不锚定）
* `apps/api/src/products/products.service.ts` / `products.controller.ts` —— 四个筛选参数 + 按系列（官方目录顺序）排序
* `apps/web/src/lib/labels.ts` —— 系列 / 气体 / 锚定 的中文映射与下拉选项
* `apps/web/src/components/CrudResource.tsx` —— 新增可选 `toolbar`（筛选条）与 `scrollX`
* `apps/web/src/pages/SetupPage.tsx` —— 产品目录卡片：新列 + 三个筛选 + 关键词 + 地址栏保持筛选状态

**文档**
* `docs/catalog-dedupe.md`（本文件）、`tools/catalog/README.md`（新增「去重合并」一节）

**未改动**：数据库结构（**本轮不加迁移**）、订单 / 计划单 / 仓储 / 账目 / 开票业务逻辑、既有取价口径。
