# 产品名归一（{size}-{model}）+ 型号提炼 + 归位（默认包装 / 备注）+ 归一后再次去重

> 甲方 2026 规则：**产品名统一为 `{size}-{model}`**（size 用官方目录 size setting **原值，不补零不删零**，
> model 用目录型号代码）；**从名称提炼型号后按 (model, size) 再次去重**（不同 size 绝不合并）；
> **产品号码 / 塑料贴盖 → 默认包装**，**其余多余信息（品牌 / 刻字 / 重量 / 货号 / 尺寸描述）→ 备注**；
> **同一型号可以有多种默认包装**。
>
> 结论先行：
> **① 191 条「型号 + size」都锚定的档案全部归一为 `{size}-{model}`（185 条名字真的被改写），其余 452 条
> （399 未锚定 + 53 未写 size）按「不臆造」原则保持现状并逐条列清单；**
> **② 本地实测产品档案 643 → 643 条（本次新增合并 0 条：上一轮已按 (型号,size) 合并过；脚本的再次去重
> 逻辑由单测 + e2e 覆盖并证明可合并，见 §5）；**
> **③ 归位：默认包装（1:N 新表）新增 217 行（产品名归位 63 + 既有文本列回填 154）→ 同型号多包装可查看/编辑；
> 备注写入 51 行；原始名 `legacy_name` 留档 185 行（信息零丢失）；**
> **④ 悬空引用 0、业务行数（订单 277 / 订单行 1844 / 报价 2582）一条不减、复跑幂等（全 0）；**
> **⑤ 系列筛选改为包含匹配：?series=AMERICAN 由 0 条 → 142 条；**
> **⑥ 回归全绿：jest 347 / quote-draft 215 / excel-order 169 / invoice 142 · 65 · 105 / 去重 e2e 38 / 归一 e2e 41；
> api、web 构建通过；docker compose up -d --build 后 3 容器 Up、日志 ERROR=0、容器内自动迁移到位。**
> **未 push、未触碰云端 47.114.92.228。**

---

## 〇、2026 关键纠正（本轮）：**前缀数字优先解释为 size**

> 甲方口径（最高优先级）：**当「数字-其余部分」中的其余部分能锚定到目录型号时，该数字是 size，不是型号的一部分。**
> 即 **3-GPN = size 3 + 型号 GPN**（不是型号 3GPN），规范名 `3-GPN`，并与其它「GPN size 3」的记录
> （`GPN-3` / `3-GPN 割嘴 3#` / `GPN CUTTING NOZZLE 3#`）**合并成同一条产品**。

| # | 规则 | 实测输出 |
| --- | --- | --- |
| 1 | **前缀数字 + `-/_/#` 紧贴型号** → 该数字是 size，其余部分是型号 | `3-GPN` → **型号 GPN / size 3**；`割嘴 3-GPN 产品号码6029` → 同上；`割嘴 3#-GPN` → 同上 |
| 2 | 多条前缀写法同时成立时取**最靠左**的那条 | `割嘴 1-3-GPN 产品号码6031` → **型号 3GPN / size 1**（不是 size 3 + GPN）；`0-1-101` → 1-101 / size 0 |
| 3 | 两条安全约束（实测反例，防误判） | ① 数字与型号必须由 `-/_/#` 紧贴（空格不算）：`乙炔割嘴1-101-2 102g` 里的 102 是克重，**不**当型号；② 数字要**自成令牌**（左边不能是字母数字或 `-/_/#`）：`SC-12-4` 里的 12 **不**当型号 41 的 size |
| 4 | 前后数字**冲突**时不猜 → 进人工确认清单 | `割嘴 1-GPN 2#` → 尺寸有歧义，保持现状；`3-GPN 割嘴 2#` → 冲突后退到「型号 3GPN + size 2」（与旧口径一致，价格不受影响） |
| 5 | 后缀 `#N` / `N#` 的**描述段窗口 14 → 20 字符**（甲方点名的写法，仍必须有 `#` 号） | `1503 Cutting nozzles 4#` → **4-1503**；`GPN CUTTING NOZZLE 2#` → **2-GPN**；`1503 cutting nozzles #6镀铬` → **6-1503** |
| 6 | 不同 size / 不同型号照样**绝不合并** | `3-GPN`（GPN size 3）≠ `3-3GPN`（型号 3GPN size 3）；`0/00/000-GPN` 仍是三条 |

### 0.1 两份实现同步（不漂移）

| 实现 | 文件 | 同步方式 |
| --- | --- | --- |
| 工具侧（JS） | `tools/catalog/lib/product-model.mjs` | 新增 `prefixSizeAt()` + 候选排序（前缀 size 优先、左端优先） |
| 服务端（TS） | `apps/api/src/ai/product-model.ts` | 同一函数 / 同一排序逐行对齐 |
| 一致性校验 | `tools/catalog/verify_parity.mjs` | 1536 个真实名称逐字段比对：**一致 1536 / 不一致 0** |

### 0.2 云端生产库（47.114.92.228）本轮实测

| 指标 | 前 | 后 |
| --- | --- | --- |
| products 档案数 | 644 | **631**（−13） |
| 名称可锚定（型号 + size 都锚定） | 191 → 本轮规则后 204（含待并入的 13 条） | **191 个唯一 (型号,size)**（覆盖 204 条写法） |
| 型号已锚定但名称未写 size | 52 | **39** |
| 型号未锚定目录 | 401 | 401（不臆造，保持现状） |
| 合并 | — | **13 条并入 7 组**（其中 GPN size 3 并入 4 条：`割嘴 3-GPN 产品号码6029`、`割嘴 3#-GPN`、`GPN CUTTING NOZZLE 3#`、`victor … 3-GPN`） |
| 引用重挂 | — | 28 行（订单行 14 + 报价 14）；唯一约束冲突删除 0 行 |
| 业务行数（订单 853 / 订单行 6851 / 报价 2616 / 包装 219→221） | — | **一条不减**（packagings 为归位新增 2 行）；悬空引用 0 |
| 幂等复跑 | — | products 更新 0 / 删除 0 / 包装新增 0 / 残留差异 0 ✅ |

### 0.3 本轮仍未解析（保持现状，逐条列清单：`normalize_unanchored_products.csv` 440 条）

| 类别 | 条数 | 代表 + 原因 |
| --- | --- | --- |
| 型号未锚定目录 | 401 | `2-W` / `8-MFA` / `10-MFN`（W / MFA / MFN 族不在官方目录）、`106HC-2`（甲方已驳回该别名）、`PNM-#1内嘴`、`GK3-00`、`G03-0`、`WS10111乙炔割嘴 101-1-1`、`6290VVC 0` |
| 型号已锚定但名称未写 size | 39 | 都是名字里**确实没有**可判定 size 的写法（见下表），脚本不猜 |

**39 条「未写 size」逐类原因**：

| 写法 | 举例 | 为什么不解析（不臆造） |
| --- | --- | --- |
| `Nº N`（编号写法） | `丙烷割嘴 GPN Nº 1`、`割嘴 6290-NFF Nº2`、`乙炔割嘴 1-101 Nº 1` | `Nº` 是「编号」还是「size」**目录里没有依据**；虽与孔径/厚度吻合，仍**需甲方点头**后才能作为 size 规则启用 |
| 型号 + 割嘴 + 分数 | `ANME 割嘴 1/16`、`PNME割嘴 1/32 贴不干胶标注尺寸` | 分数与型号之间隔着描述文字且**没有 `#` 号**，按现行安全口径不当 size（否则「包装 500只/箱」这类数字也会被误当 size） |
| 双型号 + `#N` | `1503/1534 割嘴 12#` | `#` 号前的描述段里含数字（另一个型号 1534），现行「描述段不含数字」约束下不解析 |
| 型号混写 / 括号 | `229-0(PNME)`、`GIOCWELD PNME`、`仿GPN割嘴` | 名字里型号与尺寸混写（括号里是另一个型号），无法唯一确定 (型号, size) |
| 只写了型号 | `乙炔割嘴 1-101`、`割嘴1502`、`GPN 割嘴` | 型号锚定到了，但**名字里没有 size** —— 是否对应某个默认档位需甲方确认 |

---

## 一、甲方规则与样例（判定口径）

| # | 规则 | 样例（实测输出） |
| --- | --- | --- |
| 1 | 产品名 = `{size}-{model}`，size 取目录**原值** | `261 割嘴 0#` → **`0-261`**；`000-3-101`、`0-1-101`、`1/16-ANME` |
| 2 | 同一 (model, size) 的不同写法是**同一条** | `0-1-101` ≡ `1-101 割嘴 0#` ≡ `1-101 size0` ≡ `乙炔割嘴 1-101 #0` → **`0-1-101`** |
| 3 | **不同 size 绝不合并**（前导零逐字符） | `0-1-101` / `00-1-101` / `000-1-101` 是三条；`GPN` size `0`/`00`/`000` 三条 |
| 4 | 产品号码 · 塑料贴盖 → **默认包装** | `割嘴 MC-12-1# 产品号码6003` → 包装 `产品号码6003`；`塑料盖贴：1-101 1` → 包装 |
| 5 | 其它多余信息 → **备注** | `HARRIS 丙烷割嘴6290-NX-2 53g\n代码：4187` → 备注 `HARRIS 53g ｜ 代码:4187` |
| 6 | 主观判断**不臆造** | `106HC-2`（目录无此型号）、`割嘴 1-GPN 2#`（尺寸有歧义）、`乙炔割嘴 1-101`（没写 size）→ 名字与目录列**一行都不写**，只列清单 |

### 1.1 归位规则（写死在 `tools/catalog/lib/normalize-core.mjs`，可被单测复算）

| 名称里的内容 | 归到哪里 | 例（实测） |
| --- | --- | --- |
| **产品号码** | 默认包装（1:N） | `产品号码6023`、`产品号码6003` |
| **塑料盖 / 塑料盒盖 / 盖贴 / 贴盖 / 塑壳** | 默认包装（1:N） | `塑料盖贴:1-101 1`、`GPN #3 塑料盖贴:GPN` |
| 包装 / 彩盒 / 彩卡 / 泡壳 / 吸塑 / 尼龙袋 / PP袋 / 塑料袋 / 纸箱 / 中盒 / 盒盖 / 说明书 / 散装 / 不干胶 / 标贴 / 商标 / 条码 | 默认包装（1:N） | `包装:塑料盒贴`、`仿包装` |
| 品牌（VICTOR / HARRIS / smith / Koike…）、**货号 / 代码**、克重、刻字内容、尺寸描述、其它备注性文字 | 备注 `products.remark`（多值以 ` ｜ ` 连接） | `HARRIS 53g`、`代码:4187`、`货号:4210`、`刻字内容:如右图所示41 12` |
| 产品类别 / 款式 / 气体词（割嘴 / 喷嘴 / 内嘴 / 外嘴 / 乙炔 / 丙烷 / 澳大利亚款式…） | **丢弃**（这些信息已在 `type` / `series` / `gas_type` 列里） | `乙炔割嘴`、`澳大利亚款式乙炔 割嘴` |

> 口径说明（**我做的判断，列出来待确认**）：
> ① 「**货号 / 代码**」按甲方原话归**备注**，只有「**产品号码**」归默认包装；
> ② 泛化的产品词（割嘴 / 乙炔 / 款式…）不计入备注 —— 否则每条产品的备注都会被「割嘴」刷屏，
>    而这些信息在 `type` / `series` / `gas_type` 里已有；
> ③ 归一前的**完整原始名**一律写入 `products.legacy_name`，任何信息都不会丢（可随时核对 / 回退）。

---

## 二、数据模型改动（迁移**只新增**，向后兼容）

新增迁移 `apps/api/drizzle/0025_product_packagings.sql`（启动 API 自动执行，已实测）：

| 改动 | 说明 |
| --- | --- |
| `products.remark text` | 备注（归一后从产品名里归位的多余信息） |
| `products.legacy_name text` | 归一前的原始产品名（无损留档） |
| **新表 `product_packagings`** | `id / product_id / packaging / note / source / created_at / updated_at`；`product_id` 外键 `references products(id) on delete cascade`；**唯一索引 (product_id, packaging)**（幂等兜底）+ 普通索引 (product_id) |

**为什么是 1:N 新表，而不是把 `default_packaging` 改成数组**：
① **迁移只新增** —— 既有 `default_packaging` 文本列**原样保留**，订单 / 计划单 / 报价 / 标签 / 报表 / e2e 的既有读取路径**零改动**；
② 前端可增删改每一行包装（含备注与来源），完整表达「同型号多包装」；
③ `(product_id, packaging)` 唯一索引让归一脚本可反复跑而不重复插。
`source` 取值：`name`（从产品名归位）/ `legacy`（既有文本列回填）/ `manual`（界面新增）。

**向后兼容双保险**：接口返回 `packagings` 多值数组；若某产品在 `product_packagings` 里还没有行、而
`default_packaging` 非空，则**虚拟合成**一条 `source='legacy'`（`id=null`）返回 —— 老数据在界面里也能看到、能编辑。
另外「界面保存包装列表」时会同步把**第一条**写回 `default_packaging`，老的取价 / 打印路径仍然拿到有意义的值。

---

## 三、修正脚本（`tools/catalog/normalize_products.mjs`）

**默认 dry-run、单事务、幂等**；判定逻辑全在纯函数 `lib/normalize-core.mjs`（可被单测直接验证），
脚本只负责读库 / 写库 / 报告；重挂外键与写库范围与既有 `dedupe_products.mjs` **共用同一实现**（`lib/rehang.mjs`）。

**写库范围（一个事务）**
* 只 `update` **型号 + size 都锚定**的产品行：`name / catalog_model / size_spec / series / gas_type /
  orifice_mm / thickness_range / catalog_anchor / legacy_name / remark`（`default_packaging` **只补空**，不覆盖）；
* 只 `insert` `product_packagings`（`on conflict do nothing`）；
* 合并组：`update` 引用表的 `product_id` → 存活记录，再 `delete` 被并入的 `products` 行（业务行不删）；
* **未锚定 / 未写 size 的行一行都不写**；不删任何业务行（唯一约束冲突的重复行除外，逐条计数上报）。

**幂等的做法**：归一的**输入**一律取 `legacy_name ?? name`（第一次跑用现名、之后用留档原名），
所有目标值都是「原始名 + 目录」的**纯函数**结果；备注按片段并集合并、包装靠唯一索引去重、
`legacy_name` 只写一次、`default_packaging` 只补空。第二次跑必然 0 改动（脚本自带复跑自校验）。

**命令**

```powershell
# ① dry-run（只报告）+ 写出三份清单 CSV
node tools/catalog/normalize_products.mjs --dsn "postgres://fms:<密码>@<主机>:5432/fms"
# ② 正式写入（单事务，失败自动回滚）
node tools/catalog/normalize_products.mjs --dsn "<DSN>" --apply
# ③ 幂等复核（复跑应全 0）
node tools/catalog/normalize_products.mjs --dsn "<DSN>" --apply
# ④ 甲方确认其它型号写法后再启用别名（默认不启用，绝不臆造）
node tools/catalog/normalize_products.mjs --dsn "<DSN>" --aliases tools/catalog/catalog_model_aliases.candidate.json
```

**输出**：命名变更条数 · 新提炼出的型号数 · 新合并条数 · 包装/备注归位条数 · 未锚定清单（含原因）·
重名提示 · 型号紧凑匹配跨文字提示；CSV 存档：`normalize_products_renames.csv`（命名变更 185 行）、
`normalize_unanchored_products.csv`（未锚定 452 行）、`normalize_moved_info.csv`（包装/备注归位 268 行）。

---

## 四、前端（设置 · 主数据 → 产品目录）

| 位置 | 改动 |
| --- | --- |
| 产品名列 | 标题改为「产品名（size-型号）」，直接展示归一后的 `0-1-101` 形式（悬停看全文） |
| **默认包装列** | 改为**多值展示**（一行一个 Tag，超过 2 条显示 `+N`，悬停看全部） |
| **备注列（新增）** | 展示 `remark`（品牌 / 刻字 / 重量 / 货号 / 尺寸描述） |
| **编辑弹窗** | 「默认包装（可多种）」= `Form.List`：可增删每一行包装 + 每行可选备注；新增「备注」输入框；第一条包装保存时同步到既有文本字段 |
| 筛选 | 系列 / 气体 / 锚定 / 关键词**全部保留**；**系列改为包含匹配**（占位与提示同步更新：AMERICAN 命中 AMERICAN STYLE CUTTING TIP） |

接口侧同步：`GET /api/products` 返回 `packagings`（1:N）+ `remark` + `legacyName`；
`POST /api/products`（新增）、`PATCH /api/products/:id`（编辑）接受 `packagings: [{packaging, note}]`（整表替换）与 `remark`。

---

## 五、本地实测（真实执行，命令与输出）

### 5.0 环境

`fms_normalize`（宿主 15433）= 现有本地库 `fms_dedupe2`（**643 条**产品 / 277 份订单 / **1844 条订单行** / **2582 条报价**）
+ 迁移 `0025`。**与云端 645 条的差异**：云端另有 2 条未锚定档案（用户报告 645 / 401 未锚定，本地为 643 / 399），
规则与脚本完全一致，云端跑出来的条数会按同样的口径 +2。

```powershell
# 迁移：直接启动一次 API 即自动建表（已实测）
DB_HOST=localhost DB_PORT=15433 DB_NAME=fms_normalize PORT=3999 node dist/main
\d product_packagings   # → 表存在，含 (product_id, packaging) 唯一索引与外键
select column_name from information_schema.columns where table_name='products' and column_name in ('remark','legacy_name');
#  → legacy_name / remark 两列已新增
```

### 5.1 dry-run（只报告，不写库）

```powershell
node tools/catalog/normalize_products.mjs --dsn "postgres://fms:fms@localhost:15433/fms_normalize_fresh" --sample 12
```

```
=== 一、扫描与归一 ===
  产品档案总数                  643
  型号 + size 都锚定（可归一）   191
  —— 型号已锚定但名称未写 size   53（保持现状，不猜 size）
  —— 型号未锚定目录             399（保持现状）
  **命名变更条数**              185（改为 {size}-{model}；已是标准名的不计）
  **新提炼出的型号数**          191 个（model × size 组合；本次从名称提炼出型号的行 191 条，
                                其中库里原先没有/不一致而**新增提炼**的 0 条）
  **新合并条数**                0（0 个 (model,size) 分组；不同 size 绝不合并）
  归一后档案数（预计）          643

=== 二、包装 / 备注归位 ===
  默认包装（1:N）新增行          217（其中从产品名归位 63 ／ 既有 default_packaging 回填 154）
  备注写入行数                  51
  原始名留档（legacy_name）      185

=== 三、未锚定清单（保持现状，脚本不猜） ===
  型号未锚定目录                     399 条
  型号已锚定但名称未写 size             53 条
  合计 452 条 → 明细写入 tools/catalog/normalize_unanchored_products.csv
  ⚠ 型号紧凑匹配跨过无关文字的档案 1 条（归位未做位置切割，整名归入包装/备注）：#142

=== 三b、归一后与既有档案重名（保持现状，交甲方确认） ===
  归一后的名字 "3-GPN"：来自 #16，与未改名档案 #22 同名

=== 四、命名样例（前 12 条，共 185 条） ===
  #6   "GPN-1"                        →  1-GPN
  #7   "GPN-2"                        →  2-GPN
  #9   "割嘴 MC-12-1# 产品号码6003"    →  1-MC12
  #11  "割嘴 SC-12-2# 产品号码6001"    →  2-SC12
  #16  "GPN-3"                        →  3-GPN
  #24  "割嘴 2-3-GPN 产品号码6032"     →  2-3GPN
  #33  "HARRIS 丙烷割嘴6290-NX-2 53g 代码：4187" →  2-6290NX
  #62  "乙炔割嘴1-101-2 102g 代码：4191" →  2-1-101
  #81  "乙炔割嘴1-101 0# 产品号码6023" →  0-1-101
  #90  "乙炔割嘴3-101 00# 产品号码6017" →  00-3-101
  #298 "261 割嘴 0#"                  →  0-261        ← 甲方样例
  #142 "割嘴 GPN #3  塑料盖贴：GPN-3"  →  3-3GPN

=== 五、包装 / 备注归位样例 ===
  包装 #81  [name]    "产品号码6023"
  包装 #114 [name]    "塑料盖贴:1-101 1"
  包装 #33  [legacy]  "标贴尺寸：80x16mm 塑料盒盖用黑色"
  备注 #33  "HARRIS 53g ｜ 代码:4187"
  备注 #40  "smith 93g ｜ 代码:4157"
```

> **「新提炼出的型号数」口径**：本次从产品名成功提炼出「型号 × size」的档案 **191 条 / 191 个组合**；
> 其中**库里原先没有型号、或与本次提炼结果不一致而真正新增**的 = **0 条**（上一轮已经锚定好了）。
> 若甲方确认别名（见 §7），这两个数会变成 **228 / 192**（新增提炼 **37 条**）。

### 5.2 apply（单事务）+ 幂等复核

```powershell
node tools/catalog/normalize_products.mjs --dsn "postgres://fms:fms@localhost:15433/fms_normalize" --apply
node tools/catalog/normalize_products.mjs --dsn "postgres://fms:fms@localhost:15433/fms_normalize" --apply   # 复跑
```

```
=== 写入完成（第一次） ===
  products 更新行数         185
  products 删除行数         0（目标 0）
  product_packagings 新增    217（目标 217）
  引用重挂行数合计          0
  唯一约束冲突删除行数      0
  products 现有行数         643
  复跑残留差异行数          0  ✅ 幂等（第二次跑应改 0 行）
  仍缺的默认包装行          0  ✅ 全部就位
  仍有多条的 (型号,size) 组 0  ✅ 全部唯一
  business row counts（前 → 后）：
    products      643 → 643 ✅   orders         277 → 277 ✅   order_lines  1844 → 1844 ✅
    product_quotes 2582 → 2582 ✅   plan_sheets / inventory / outbound_lines / goods_receipt_lines /
    stocktakes / product_processes 全部 0 → 0 ✅
  悬空引用（引用 products 的外键）：0 行  ✅

=== 写入完成（复跑） ===
  products 更新行数 0 ／ 删除 0 ／ product_packagings 新增 0 ／ 重挂 0 ／ 冲突删除 0
  复跑残留差异行数 0 ✅ ／ 仍缺的默认包装行 0 ✅ ／ 仍有多条的 (型号,size) 组 0 ✅ ／ 悬空引用 0 ✅
```

### 5.3 SQL 核对（归一结果 / 多默认包装 / 悬空引用）

```sql
select id, name, catalog_model, size_spec, remark, legacy_name from products where id in (33,81,298,142,16,22,46);
```

```
 id  | name     | catalog_model | size_spec | remark                  | legacy_name
-----+----------+---------------+-----------+-------------------------+-------------------------------
  33 | 2-6290NX | 6290NX        | 2         | HARRIS 53g ｜ 代码:4187 | HARRIS 丙烷割嘴6290-NX-2 53g…
  81 | 0-1-101  | 1-101         | 0         |                         | 乙炔割嘴1-101 0# 产品号码6023
 298 | 0-261    | 261           | 0         |                         | 261 割嘴 0#
 142 | 3-3GPN   | 3GPN          | 3         |                         | 割嘴 GPN #3  塑料盖贴：GPN-3
  16 | 3-GPN    | GPN           | 3         |                         | GPN-3
  22 | 3-GPN    | 3GPN          |           |                         | （未改名：名称未写 size）
  46 | 0-GPN    | GPN           | 0         |                         | （未改名：本来就是标准名）

select product_id, packaging, source from product_packagings where product_id in (33,81,142);
--  33 | 标贴尺寸：80x16mm 塑料盒盖用黑色 | legacy
--  81 | 1-101割嘴                        | legacy
--  81 | 产品号码6023                     | name     ← 同一型号两种默认包装
-- 142 | GPN #3 塑料盖贴:GPN              | name
```

* **悬空引用**：8 张引用表（order_lines / product_quotes / inventory / product_processes / plan_sheet_lines /
  goods_receipt_lines / outbound_lines / stocktakes）**全部 0 行**（脚本内置核对，apply 后自动打印）；
* **不同 size 各自独立**：`0-1-101` / `00-1-101` / `000-3-101` / `0-3-101` 等各自一条，无一被合并；
* **业务行数**：订单 / 订单行 / 报价一条不减（本次合并 0 条，故无重挂）。

### 5.4 接口实测（API 连归一小库）

```
GET /api/products                              → 200，642 条（默认隐藏占位档案）
GET /api/products?series=AMERICAN              → 200，142 条   ← **改造前 0 条**（精确匹配踩空）
GET /api/products?series=AMERICAN%20STYLE%20CUTTING%20TIP → 200，142 条（全称仍然可用）
GET /api/products?series=japanese              → 200，  24 条（大小写不敏感）
GET /api/products?gasType=LPG&anchor=matched   → 200， 145 条
GET /api/products?anchor=unmatched             → 200， 398 条
GET /api/products?kw=0-261                     → 200，   1 条（id=298 name=0-261 legacyName=261 割嘴 0#）
GET /api/products?kw=0-1-101&anchor=matched    → packagings = [1-101割嘴(legacy), 产品号码6023(name)]
PATCH /api/products/81 {packagings:[…2 条…]}    → 200，回读 2 条 source=manual，defaultPackaging 同步为第一条
POST  /api/products {name, type, packagings:[甲,乙]} → 201，返回 2 条包装（新增路径同样支持多包装）
```

### 5.5 场景 B：甲方确认「其它型号写法」后的影响（**默认不启用**，仅供决策）

`tools/catalog/catalog_model_aliases.candidate.json` 里只有两条**候选**：
`106HC → 106`、`102HC → 102`（依据：现有解析器其实已经认了 `106HC 2#` 这种写法，只是 `106HC-2` 这种连字符写法没认）。

```powershell
node tools/catalog/normalize_products.mjs --dsn "…/fms_normalize_b" --aliases tools/catalog/catalog_model_aliases.candidate.json
```

| 指标 | 默认（不启用别名） | 启用候选别名 |
| --- | --- | --- |
| 型号 + size 都锚定 | 191 | **228** |
| **新提炼出的型号（行 / 组合）** | 191 / 191（新增提炼 0） | **228 / 192（新增提炼 37）** |
| **新合并条数** | 0 | **36 条（16 个 (model,size) 分组）** |
| 未锚定 | 399 | 358 |
| 归一后档案数 | 643 | **607** |

---

## 六、自测（全部真实执行）

```
$ node --test tools/catalog/normalize_products.test.mjs      → tests 19  pass 19  fail 0
$ node --test tools/catalog/dedupe_products.test.mjs         → tests 13  pass 13  fail 0
$ node apps/api/test/normalize-products-e2e.mjs              → 通过 41 项，失败 0 项
$ node apps/api/test/dedupe-products-e2e.mjs                 → 通过 38 项，失败 0 项
$ npm test（apps/api）                                        → Test Suites: 23 passed  Tests: 347 passed
$ node tools/catalog/verify_parity.mjs                       → 共 1525 个名称，一致 1525，不一致 0
$ npm run build（apps/api，nest build）                       → 通过
$ npm run build（apps/web，tsc -b && vite build）             → 通过（仅 chunk >500kB 体积提示）

# 回归（每个套件独立空库 + 真实 HTTP）
quote-draft-e2e     通过 215 项，失败 0 项
excel-order-e2e     通过 169 项，失败 0 项
invoice-e2e         通过 142 项，失败 0 项
invoice-simple-e2e  通过  65 项，失败 0 项
invoice-red-e2e     通过 105 项，失败 0 项
```

**单测覆盖（19 项，纯函数、不连库）**：命名规则（`261 割嘴 0#`→`0-261`、`1-101 割嘴 0#`→`0-1-101`、
`000-3-101`）、不同 size 不合并、同写法再合并、包装/备注归位（产品号码·塑料盖贴→包装；品牌·克重·货号→备注；
类别词是噪音）、不臆造（`106HC-2` / `1-GPN 2#` / 未写 size）、归位幂等（第二跑用 `legacy_name`）、
备注多值合并幂等、**多包装去重**、合并时包装跟着存活记录走、别名默认不生效、跨文字紧凑匹配不做位置切割。

**e2e 覆盖（41 项，真实库 + 真实脚本）**：三种写法三合一 → `0-1-101`；`261 割嘴 0#`→`0-261`；
`00-1-101` / `000-3-101` 保持独立；订单行 / 报价重挂 + 库存 / 工序唯一约束冲突行按设计删除；
既有 `default_packaging` 回填 + 产品号码归位 → 同型号多包装；未锚定 / 未写 size 一行不写；
悬空引用 0；业务行数不减少；复跑全 0（`--apply` 三次仍 0）。

**容器（`docker compose up -d --build`）**

```
Image fms-app:local Built / Image fms-nginx:local Built
Container fms-postgres Running（Healthy）→ fms-app / fms-nginx Recreated → Started

$ docker ps
 fms-nginx     Up        0.0.0.0:80->80/tcp
 fms-app       Up        3000/tcp
 fms-postgres  Up (healthy)

$ curl http://127.0.0.1/api/health            → {"status":"ok","db":"up","time":"…"}
$ docker logs fms-app   | Select-String ERROR → 0
$ docker logs fms-nginx | Select-String ERROR → 0
$ docker exec fms-postgres psql -U fms -d fms -t -A -c "select count(*) from information_schema.tables where table_name='product_packagings';
                                                            select count(*) from information_schema.columns where table_name='products' and column_name in ('remark','legacy_name');"
  → 1 / 2     （容器库已自动跑完迁移 0025）
```

> 说明：`docker compose up -d --build` 在 PowerShell 里退出码可能显示 1 —— 那是 docker 把构建进度写到
> **stderr** 触发的 `NativeCommandError` 噪音；容器实际全部重建并 Up（上面的 `docker ps` / `/api/health` /
> 日志 ERROR=0 都是同一条命令之后立刻取的实测结果）。

---

## 七、云端执行命令（**由甲方执行；本轮未连云端、未做任何云端写操作**）

```powershell
# ⓪ 先备份（务必）
docker exec fms-postgres pg_dump -U fms -d fms -Fc -f /tmp/fms_before_normalize.dump
docker cp fms-postgres:/tmp/fms_before_normalize.dump ./fms_before_normalize.dump

# ① 部署新代码（容器启动会自动跑迁移 0025：只新增 2 列 + 1 张表）
docker compose up -d --build
docker exec fms-postgres psql -U fms -d fms -c "\d product_packagings"     # 确认表与唯一索引就位

# ② dry-run（只报告，不写库）—— 期望：档案 645；可归一 244-ish；命名变更 ~190；新合并 0；
#                                   包装新增 ~220；备注写入 ~55；未锚定清单 401 + 53
node tools/catalog/normalize_products.mjs --dsn "postgresql://fms:<密码>@47.114.92.228:5432/fms"

# ③ 确认无误后正式写入（单事务，失败自动回滚）
node tools/catalog/normalize_products.mjs --dsn "postgresql://fms:<密码>@47.114.92.228:5432/fms" --apply

# ④ 幂等复核（复跑应全 0：更新 0 / 删除 0 / 新增包装 0 / 残留差异 0 / 悬空引用 0）
node tools/catalog/normalize_products.mjs --dsn "postgresql://fms:<密码>@47.114.92.228:5432/fms" --apply

# ⑤ （可选，需甲方先点头）启用候选别名，把 106HC / 102HC 也认成 106 / 102：
#     预计再多 37 条新提炼型号、36 条合并（档案 645 → 609）
node tools/catalog/normalize_products.mjs --dsn "postgresql://fms:<密码>@47.114.92.228:5432/fms" ^
     --aliases tools/catalog/catalog_model_aliases.candidate.json --apply

# ⑥ 只读核对（悬空引用 / 业务行数 / 不同 size 独立 / 多包装）
docker exec fms-postgres psql -U fms -d fms -c "select count(*) from products;"
docker exec fms-postgres psql -U fms -d fms -c "select p.name, count(*) from product_packagings pp join products p on p.id=pp.product_id group by 1 having count(*)>1 order by 2 desc limit 20;"
```

> **执行顺序建议**：先 ① 再 ② → 甲方看报告与三份 CSV → ③ → ④ → ⑥。
> 归一脚本**自包含**（不依赖先跑 `apply_catalog_correction`）；**跑完归一不要再跑 `apply_catalog_correction`**
> （它会把目录列按原解析重写，并覆盖 `catalog_note`）。建议业务低峰执行（单事务会锁 products 相关行）。

---

## 八、待甲方确认清单（脚本**不臆造**，一律保持现状 + 列清单）

| # | 事项 | 规模 | 需要甲方确认什么 |
| --- | --- | --- | --- |
| 1 | **其它型号写法**（如 `106HC`→`106`、`102HC`→`102`） | 候选别名 2 条，影响 **37 条新提炼 + 36 条合并** | 是否认可「`106HC-2` 就是目录型号 106 的 size 2」？点头后填 `catalog_model_aliases.candidate.json` 并用 `--aliases` 跑一次即可（默认关闭，绝不臆造） |
| 2 | **型号未锚定目录的档案** | **399 条** | 主要族：**PNM/PNME/ANM/AMN 64**、**内嘴/外嘴 P 系列 52**、**106HC/102HC 42**、**W 族 37**、**MFA/MFN 23**、**6290VVC 21**、**Nozzle № 11**、丙烷/乙炔切割喷嘴 11、G1-P/G1-A 非目录尺寸 6、其它 152。逐条明细见 `tools/catalog/normalize_unanchored_products.csv`（含原因） |
| 3 | **型号已锚定但名称没写 size** | **39 条**（本轮前 53 条；`3-GPN` 等 14 条已按 §〇 前缀数字优先规则解析并合并） | 见 §0.3 逐类原因：`Nº N` 编号写法、型号+割嘴+分数、双型号+`#N`、只写型号 —— 是否各自对应某个默认档位？（脚本**不猜 size**，需甲方点头才加规则） |
| 4 | ~~**归一后重名：`3-GPN`**~~ **（本轮已按甲方规则解决，见 §〇）** | 0 组（本轮已合并，云端 645→644 后 644→631） | 甲方 2026 裁定：`3-GPN` 就是 **GPN 的 size 3**（前缀数字优先解释为 size）→ 与其它 GPN size 3 的记录自动合并；型号 `3GPN` 仍由 `3-3GPN` 这类写法独立承载（`3-GPN` ≠ `3-3GPN`） |
| 5 | **「产品号码」归入默认包装** | 63 条 | 甲方原话是「产品号码、塑料贴盖 → 默认包装」。产品号码本质像编号，是否确实要放进「默认包装」而非「备注」？（现按原话执行，改口径只需调整 `PACKAGING_RE` 再跑，幂等） |
| 6 | **「货号 / 代码」归入备注** | 51 条 | 同上，货号与产品号码分属两个字段，请确认这是想要的 |
| 7 | **类别词不进备注** | — | `割嘴 / 乙炔 / 澳大利亚款式` 这类词被丢弃（信息已在 type / series / gas_type）。如希望保留，可改成写入备注（一次性开关） |
| 8 | **`#142` 型号紧凑匹配跨过中文** | 1 条 | `割嘴 GPN #3  塑料盖贴：GPN-3` 解析为 3GPN size 3 时，型号在名字里的位置跨过了「塑料盖贴」文字，脚本**不做位置切割**（整名归入包装），已在报告单列 |
| 9 | **`product_type` 枚举** | 73 条仍 `tbd` | 沿用上轮：日 / 法 / 澳 / 巴西式在既有枚举里没有对应值。是否扩展枚举（`jp_*` / `fr_*` / `au_*` / `br_*`）？ |
| 10 | **是否给 (catalog_model, size_spec) 加唯一索引** | 建议 | 归一后 `(型号,size)` 已唯一；加部分唯一索引可防再次重复（上轮已提，仍需点头） |
| 11 | **`remark` 是否纳入检索 / 导出** | — | 目前关键词搜索覆盖 产品名 / 型号 / size / 系列；备注里的品牌 / 货号是否也要能搜？ |

---

## 九、改动清单（**本地 commit；未 push、未触碰云端**）

**新增（迁移 / 服务端）**
* `apps/api/drizzle/0025_product_packagings.sql` —— **只新增**：`products.remark`、`products.legacy_name`、表 `product_packagings`（唯一索引 + 外键）
* `apps/api/src/products/products.service.spec.ts` —— 系列「包含匹配」口径单测（4 项）
* `apps/api/test/normalize-products-e2e.mjs` —— 归一 + 归位 + 再合并 + 多包装 + 幂等端到端自测（41 项）

**新增（工具）**
* `tools/catalog/normalize_products.mjs` —— 归一 CLI（dry-run / 单事务 / 幂等 / 报告 / 三份 CSV）
* `tools/catalog/lib/normalize-core.mjs` —— 归一**纯函数核心**（标准名 / 归位 / 分组选存活）
* `tools/catalog/lib/rehang.mjs` —— 外键重挂 + 唯一约束冲突清理（与 dedupe **共用**）
* `tools/catalog/normalize_products.test.mjs` —— 归一审定单测（19 项）
* `tools/catalog/catalog_model_aliases.candidate.json` —— **候选**型号别名（默认不启用）
* `tools/catalog/normalize_products_renames.csv`（185 行）/ `normalize_unanchored_products.csv`（452 行）/ `normalize_moved_info.csv`（268 行）

**修改**
* `apps/api/src/db/schema.ts` —— `products.remark` / `legacyName` + 新表 `productPackagings` + 类型导出
* `apps/api/src/products/products.service.ts` —— 系列**包含匹配**（`seriesLikePattern`）、列表挂 `packagings`（含 legacy 虚拟合成）、新增/编辑支持 `packagings` 整表替换与 `defaultPackaging` 同步、`findByIdWithPackagings`
* `apps/api/src/products/products.controller.ts` —— DTO 新增 `remark` 与 `packagings`（`PackagingDto`，`whitelist` 放行）
* `apps/web/src/lib/types.ts` —— `Product.remark / legacyName / packagings`、`ProductPackaging`
* `apps/web/src/components/CrudResource.tsx` —— 新增 `kind: 'packagings'`（Form.List 多值编辑器）+ 数组字段提交前过滤空行
* `apps/web/src/pages/SetupPage.tsx` —— 产品名（size-型号）/ 多值默认包装 / 备注列 + 编辑弹窗多包装 + 系列「包含匹配」提示
* `tools/catalog/dedupe_products.mjs` —— 外键重挂改用共享 `lib/rehang.mjs`（行为不变，e2e 38 项复跑全绿）
* `tools/catalog/lib/product-model.mjs` —— 新增 `explainProductModelSpans`（返回型号/size 命中区间）与 `withModelAliases`；`explainProductModel` 结果**完全不变**（`verify_parity` 1525/1525）
* `tools/catalog/README.md` —— 新增「产品名归一」一节与脚本表
* `apps/api/test/dedupe-products-e2e.mjs` —— CSV 存档改写到临时目录（测试不再覆盖 `tools/catalog` 下的正式清单）

**文档**
* `docs/catalog-normalize.md`（本文件）

**未改动**：订单 / 计划单 / 排期 / 仓储 / 账目 / 开票业务逻辑；既有取价口径；未 push、未触碰云端。
