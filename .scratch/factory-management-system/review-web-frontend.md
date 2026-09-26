# 工厂管理系统 Web 前端审查报告（React19 + AntD6）

## 一、前端架构概览（页面 → 组件 → lib 分层）
- 入口 apps/web/src/main.tsx：StrictMode + AntD <App> 包裹；App.tsx 无路由库，用 useState<PageKey> + Menu 点击切换，{page==='xxx' && <Page/>} 条件渲染 —— 切菜单即整页卸载，跨页状态不共享、回来重新拉取（App.tsx:44-89）。顶部 30s 轮询 /health（App.tsx:55-61）+ AlertBell 60s 轮询 /ai/alerts。
- 页面层 8 屏：首页(演示CRUD/实施横幅)、订单 OrdersPage、计划单 PlansPage、排程 SchedulingPage、仓储 WarehousePage、账目 AccountingPage、AI AiPage、设置 SetupPage。
- 组件层：CrudResource（泛型主数据 CRUD 抽象）、OrderDetailModal（共享详情弹窗）、PackComboEditor（受控复合包装编辑器+模板库）、ProcessRouteCard（工序路由差分编辑）、AlertBell、AiOrderImport（AI 导入复核全流程）。
- lib 层：api.ts（fetch 封装：错误归一取 message[0]、204/空 body 兜底）、types.ts（与后端 schema/service 对齐领域类型）、labels.ts（枚举→中文词表）、scheduling.ts（排程看板类型）。
- 数据层形态：无 react-query/SWR/统一缓存，package.json 依赖仅 react/antd/dayjs（apps/web/package.json:12-17）。每页/每 Tab 独立 useState+useEffect+手动 fetch，重复同一套 loading/error/fetch 模板。

## 二、发现清单

### [高] F1 日期“只选日期”被 UTC 化，排程/超期/预警 off-by-one（跨前后端）
用户交期是纯日期语义，落库却用 values.dueDate.toISOString()（OrdersPage.tsx:271，编辑同 body:268-281）。东八区本地 09-07 00:00 → 2026-09-06T16:00:00.000Z。前端再用 dayjs 本地格式化回显成 09-07 看着没错（OrdersPage.tsx:605），但后端对订单交期做日期字符串化全用 UTC 切片 tsToDate = toISOString().slice(0,10)（apps/api/src/scheduling/scheduling.service.ts:27-28），排程任务 dueDate='2026-09-06'、超期判定 endDate>=due（scheduling.service.ts:98,106,135）与规则预警同源 —— 排程“客户交期”与红框超期会比用户在订单里选的日期早一天（服务器无论什么 TZ，toISOString 恒 UTC，均有此偏移）。建议：日期型输入一律 dayjs(v).format('YYYY-MM-DD') 传递（AiOrderImport.tsx:355 已是此写法），并抽查服务端 date-only 语义列。

### [高] F2 SchedulingPage 保存路径无 HTTP 状态检查：失败也报成功、危险操作无确认
- ScheduleModal submit/unschedule 直接 fetch 不看 res.ok，任何 4xx/5xx 也 message.success('已排/已取消排期') 并关弹窗（SchedulingPage.tsx:393-408）；submitSchedule 同样无检查（SchedulingPage.tsx:546-553）。服务端一旦报错，用户看到成功提示但排期未落库 —— 静默丢操作。
- 对比同文件拖拽路径 moveBar 有 res.ok 检查并抛错（SchedulingPage.tsx:532-544）—— 两条路径行为不一致。
- “取消排期”破坏性操作无 Popconfirm 也无 try/catch（SchedulingPage.tsx:403-408），网络异常 unhandled rejection。

### [高] F3 无统一缓存/数据刷新一致性弱：同页 Tab 数据陈旧
- AccountingPage 七个业务 Tab 各自 useState 拉全量、Tabs 未设 destroyOnHidden（AccountingPage.tsx:24），切换不触发重拉（ReceivableTab 仅 mount 时 load，AccountingPage.tsx:155-161）。例：在“收款单”建单核销后切回“应收记录”，remain/已核销仍是旧值，除非整页重进。
- 对比 WarehousePage Tabs 显式 destroyOnHidden（WarehousePage.tsx:24）每次激活重拉 —— 同库两种行为，属疏漏。
- OrdersPage 列表/归档两份 OrderListTable（OrdersPage.tsx:79-80）各自拉取，在列表“确认”订单后归档页不自动更新；同页“新建”与“列表”靠 listTick 手动对账（OrdersPage.tsx:67-71,582）。
- 主数据下拉（customers/products）每页 mount 全量重拉且失败静默（OrdersPage.tsx:100-101,567），无跨页共享。建议轻量查询缓存（SWR）或请求级缓存+失效广播。

### [中] F4 关键初始化加载失败被静默吞掉，表单空转无根因提示
订单新建页 customers/products 失败 catch(() => {})（OrdersPage.tsx:100-101）、PlansPage.tsx:45、AiOrderImport.tsx:141-142、PackComboEditor.tsx:73、WarehousePage.tsx:170、SetupPage.tsx:94。客户目录失败时“新建订单”客户下拉为空，用户反复撞“必选客户”校验却不知是后端故障。建议表单核心下拉的失败至少给一次性 warning/错误态。

### [中] F5 甘特拖拽只能本泳道横移但无提示，跨泳道区域松手落定与视觉不符
dragUi 浮层只在原 wcKey 泳道渲染（SchedulingPage.tsx:294），pointermove 只按 X 轴算目标日（SchedulingPage.tsx:93-116），松手按原泳道+新日期保存（SchedulingPage.tsx:130-133）。拖到别的泳道区域松手看起来换道失败却静默按原道落位。建议明确“仅同泳道可拖”的视觉边界或提示改用排期面板换泳道。

### [中] F6 巨型单文件 + 结构性重复，维护性承压
- SchedulingPage.tsx 642 行（GanttLane+3 Modal+主面板）、AccountingPage.tsx 595、OrdersPage.tsx 660、WarehousePage.tsx 594。
- “未配置工序路线→成品直报”文案两页重复（PlansPage.tsx:242、SchedulingPage.tsx:422-424）；confirmingId/deletingId/acting 逐表复制。
- 时间格式化两套并存：dayjs(...).format（OrdersPage.tsx:610）vs v.slice(0,16).replace('T',' ')（SetupPage.tsx:21、WarehousePage.tsx:50）——slice 不做时区换算，展示口径不一致。

### [中] F7 类型安全打折：any 与强制断言绕过契约
- AccountingPage SlipModal 通篇 as any[]/as any（AccountingPage.tsx:59,68,81,101,118），残留死代码 const url;void url（:57,64），注释自述“服务端不支持该筛选，本地过滤”全量拉取再过滤。
- PlansPage 把 PlanSheetLine 强转 as unknown as OrderLine[] 复用订单行表格（PlansPage.tsx:293,301-302），掩盖字段差异；SchedulingPage catch (e: any)（:135,399,561）。
- lib/scheduling.ts 的 SchedTask 与 lib/types.ts 的 PlanSheetLine 字段未统一。

### [中] F8 表单校验与后端 DTO 不对齐，错误延迟到服务端 400
- 数量列 InputNumber 只有 min=1 无 precision=0（OrdersPage.tsx:372、AiOrderImport.tsx:414），后端 @IsInt（orders.controller.ts:18-20）—— 输入 1.5 保存时才收到含糊 400。
- 编辑态 Tab 标签仍为“+ 新建订单”（OrdersPage.tsx:75-81）；快速建档/行校验多为手动 warning（OrdersPage.tsx:257-263），有覆盖但散落。
- 金额在 number 上运算展示 toLocaleString（OrdersPage.tsx:591、AccountingPage.tsx:15、PlansPage.tsx:322），多币种+大额核销建议定点（分）处理。

### [低] F9 AI 学习反馈 P0（dab94ee）：不再静默丢 OK，但“可见可重试”只做一半
- 已落地：失败入 localStorage 队列（上限50）+ warning（OrdersPage.tsx:26-32,319-321）；进订单页与建单成功时自动 flush（OrdersPage.tsx:58,317,323），后端 ai-feedback.controller POST /ai/feedback 可收到。
- 缺口：flush 失败静默（OrdersPage.tsx:58 .catch(()=>{})），积压条数/最后失败无 UI、无手动“重试补传”按钮；payload 恒 400 会每入口重试却不可见；localStorage 单浏览器，另一台 PC 的失败不会由此台补传。建议订单页加“学习反馈积压 N 条·重试”状态条。

### [低] F10 其余 UX/健壮性细节
- SchedulingPage 主 load() 无 try/catch，三路 fetch 任一失败 Promise.all reject、任务区静默空白（SchedulingPage.tsx:511-522）。
- AI 查数页把系统错误当 AI 气泡展示、无停止/重试、无流式（AiPage.tsx:41-43,79-81）。
- AI 图片 8MB 直送 dataURL 无预降采样（AiOrderImport.tsx:13,205-212）。
- SetupPage 未配置 key 用 status=warning 黄框（SetupPage.tsx:232），易误读为错误。
- 性能整体健康：表格分页 ≤20（OrdersPage.tsx:656 及各仓储/账目表），甘特 DOM 直写跟手（SchedulingPage.tsx:102-116），无虚拟滚动需求；App 30s/AlertBell 60s 轮询低频；useMemo 无滥用，仅个别常量级 useMemo（OrdersPage.tsx:336）意义有限。

## 三、亮点（读到代码证实的 5 条）
1. AI 草稿持久化+防覆盖做得细：单槽后端草稿 + 700ms 防抖自动保存 + 已有草稿时新解析先 Modal.confirm 二次确认（AiOrderImport.tsx:109-115,173-189），恢复横幅与放弃入口齐备，任何一步人工修正不丢。
2. 甘特拖拽实现是自研泳道里的高阶写法：选中浮起→DOM 直改跟手零 React 重渲染（SchedulingPage.tsx:102-116）、suppressClickRef 抑制拖后误弹（:128-129）、落点竖线+目标日期提示、未移动不调接口、拖完 commit 才刷新；注释讲清了 pointerEvents 与 hit-test 的坑。
3. 错误链路设计好：api() 归一后端 ValidationPipe 400 的 message[] 取首条、204/空 body 兜底（api.ts）；多数保存/删除带 message.error('xxx:'+e.message) 与 loading 防重复提交；破坏性动作普遍有 Popconfirm+后果文案（OrdersPage.tsx:619-626、PlansPage.tsx:162-169、WarehousePage.tsx:217,356）。
4. 共享组件抽象方向正确：CrudResource 一套通用 4 实体（SetupPage.tsx:116-141）、PackComboEditor 受控复合包装+模板库、OrderDetailModal 明确消除 OrdersPage/SchedulingPage 两处重复（OrderDetailModal.tsx:6-10）、ProcessRouteCard 用 original/rows JSON 比对做 dirty 态（ProcessRouteCard.tsx:88）。
5. 前后端契约一致性用心：前端类型与后端 service 返回结构逐字段对齐（lib/scheduling.ts ↔ scheduling.service.ts:112-145）；订单 AI 解析 AiResolveResult 与后端 ResolveResult 完全同构（AiOrderImport.tsx:16-28 ↔ order-parser.service.ts:49-62）；枚举中文文案集中 labels.ts 与后端 schema 词表对应。

## 四、建议优先级
1. 先修 F1（日期语义，影响排程超期/预警正确性）与 F2（失败却报成功，破坏信任）。
2. F3 引入统一数据层或至少让 AccountingPage Tabs 与 WarehousePage 一致（destroyOnHidden 或激活重拉）。
3. F4-F8 按“反馈可见性 → 表单校验对齐 → 拆文件去重 → 类型收敛”顺序演进；F9 补积压可见重试条即可闭环历史 P0。