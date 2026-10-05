/** 与后端 schema.ts / service 返回结构对齐的类型 */

export interface Product { id: number; name: string; type: string; defaultPackaging?: string | null; defaultRouting?: string | null; safetyStock: number; createdAt?: string; updatedAt?: string }
export interface Customer { id: number; name: string; contact?: string | null; settlement?: string | null; creditDays: number; createdAt?: string; updatedAt?: string }
export interface Supplier { id: number; name: string; contact?: string | null; settlement?: string | null; createdAt?: string; updatedAt?: string }
export interface Operator { id: number; name: string; boundPc?: string | null; note?: string | null; createdAt?: string; updatedAt?: string }

export type PackType = 'box' | 'bag' | 'carton' | 'label'
export type PackagingSpec = Partial<Record<PackType, string>>

export type OrderStatus = 'draft' | 'confirmed' | 'production' | 'completed' | 'cancelled'
export type PlanStatus = 'draft' | 'confirmed' | 'production' | 'completed' | 'cancelled'

/** 待补项（I17）：识单落草稿时缺价/缺数量/产品未建档等逐项留痕，message 为中文诊断（界面直接展示） */
export interface PendingItem {
  code: string
  message: string
}

export interface OrderLine {
  id?: number
  productId: number
  productName?: string
  quantity: number
  unitPrice: number
  currency: 'RMB' | 'USD'
  engraving?: string | null
  packaging?: PackagingSpec | null
  /** 行级待补项；null = 普通订单行（不参与待补机制） */
  pendingItems?: PendingItem[] | null
  /** 单价来源：'quote' = 由报价记录自动补全（来源可追溯） */
  priceSource?: string | null
  /** 产品未建档时识别到的产品原文 */
  productNameText?: string | null
}

export interface Order {
  /** 留痕：录单人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  id: number
  orderNo: string
  customerId: number
  customerName?: string
  poNo?: string | null
  dueDate: string
  /** 交期待定（I17）：true 时 dueDate 是哨兵日 2099-12-31，界面应显示「待定」 */
  dueDateTbd?: boolean
  /** 未建档客户的识别原名（customerId 指向占位档案） */
  draftCustomerName?: string | null
  /** 单头待补项；null = 普通订单（不参与待补机制），[] = 识单落草稿且已补全 */
  pendingItems?: PendingItem[] | null
  /** 单头待补项的中文汇总（列表「待补」列直接用） */
  pendingText?: string
  note?: string | null
  status: OrderStatus
  createdAt: string
  updatedAt?: string
  totalAmount?: number // 后端 attachLines 按行 Σ(数量×单价)，元
  /** 订单金额（分，定点求和；开票/收款口径统一用「分」） */
  totalAmountCents?: number
  /** 已开票金额（分，含税；实时聚合未作废发票） */
  invoicedCents?: number
  /** 未开票余额（分，非负） */
  uninvoicedCents?: number
  /** 是否超额开票（累计含税 > 订单金额） */
  overInvoiced?: boolean
  /** 开票状态三态（简化交互主展示）：none 未开票 / partial 部分开票 / done 已开完 */
  invoiceState?: InvoiceState
  lines: OrderLine[]
}

export interface PackTemplate {
  id: number
  name: string
  pack: PackagingSpec
  note?: string | null
  imageUrl?: string | null
  createdAt: string
}

export interface PlanSheetLine {
  id: number
  planSheetId?: number
  orderLineId: number
  productId: number
  productName?: string
  quantity: number
  completedQuantity?: number
  engraving?: string | null
  packaging?: PackagingSpec | null
  // 工序推进（I06 整批逐道，后端 attachLines 附加）
  routeSeq?: number // 当前工序序号（1-based）
  routeTotal?: number // 产品工序路由总道数；0 = 未配路由（成品直报）
  currentStepName?: string | null // 当前工序名（无路由为 null）
  currentWcKey?: string | null
  finished?: boolean // 行是否已全工序走完/成品完成
  requiredQty?: number // 本次报工应报数（中间道=整批；末道/无路由=剩余）
}

/** 报工流水（留痕） */
export interface ReportLog {
  id: number
  planSheetId: number
  planSheetLineId: number
  routeSeq: number
  processName?: string | null
  quantity: number
  isLast: boolean
  operatorName?: string | null
  productName?: string | null
  createdAt: string
}

export interface PlanSheet {
  id: number
  planNo: string
  orderId: number
  orderNo?: string
  customerId?: number
  customerName?: string
  poNo?: string | null
  dueDate?: string | null
  note?: string | null
  orderStatus?: OrderStatus
  status: PlanStatus
  createdAt: string
  updatedAt?: string
  lines: PlanSheetLine[]
}

// ---------- 仓储域（I08） ----------

export type ReceiptStatus = 'draft' | 'confirmed' | 'voided'

export interface ReceiptLine {
  id: number
  receiptId?: number
  planSheetLineId?: number | null
  productId: number
  productName?: string
  quantity: number
}

export interface GoodsReceipt {
  /** 留痕：经办操作人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  id: number
  receiptNo: string
  planSheetId?: number | null // null=手动无单入库
  planNo?: string
  batchNo: string
  status: ReceiptStatus
  note?: string | null
  createdAt: string
  updatedAt?: string
  confirmedAt?: string | null
  lines: ReceiptLine[]
}

export interface InventoryRow {
  id: number
  productId: number
  productName?: string
  batchNo: string
  quantity: number
  safetyStock?: number
  low?: boolean
  updatedAt?: string
}

export type OqcStatus = 'pending' | 'passed' | 'exempt'
export type OutboundStatus = 'draft' | 'pending' | 'shipped' | 'voided'

export interface OutboundLine {
  id: number
  outboundId?: number
  orderLineId: number
  productId: number
  productName?: string
  quantity: number
}

export interface Outbound {
  /** 留痕：经办操作人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  id: number
  shipNo: string
  orderId: number
  orderNo?: string
  customerId?: number
  customerName?: string
  oqc: OqcStatus
  status: OutboundStatus
  note?: string | null
  createdAt: string
  updatedAt?: string
  shippedAt?: string | null
  generatedAmount?: number
  lines: OutboundLine[]
}

export interface IncomingGoods {
  /** 留痕：经办操作人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  /** 登记即 confirmed；冲销后 voided（不再计入材料成本） */
  status?: 'confirmed' | 'voided'
  id: number
  incomingNo: string
  supplierId: number
  supplierName?: string
  materialName: string
  quantity: number
  amount: number
  batchNo?: string | null
  iqcStatus: 'pending' | 'passed'
  createdAt: string
  updatedAt?: string
}

export interface Stocktake {
  /** 留痕：经办操作人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  id: number
  stocktakeNo: string
  productId: number
  productName?: string
  batchNo: string
  bookQty: number
  actualQty: number
  diffQty: number
  status: ReceiptStatus
  note?: string | null
  createdAt: string
  updatedAt?: string
  confirmedAt?: string | null
}

// ---------- 账目域（I09） ----------

export interface Receivable {
  id: number
  recvNo: string
  customerId: number
  customerName?: string
  sourceType: string
  sourceId: number
  orderNo?: string // 关联订单（order 来源直接 / outbound 旧数据经出库单中转）
  shipNo?: string
  amount: number
  currency: string
  settledAmount: number
  status: ReceiptStatus
  dueDate?: string | null
  createdAt: string
  updatedAt?: string
  remain: number
  overDue: boolean
  ageDays: number
  bucket: 'current' | 'd30' | 'd60' | 'd90' | 'd90p'
  settled: boolean
}

export interface Payable {
  id: number
  payNo: string
  supplierId: number
  supplierName?: string
  sourceType: string
  sourceId: number
  incomingNo?: string
  amount: number
  settledAmount: number
  status: ReceiptStatus
  createdAt: string
  updatedAt?: string
  remain: number
  settled: boolean
}

export type SlipMode = 'settle' | 'prepay' | 'apply'
export type SlipStatus = 'confirmed' | 'voided'

export interface SlipLine { id: number; amount: number; recvNo?: string; payNo?: string; orderNo?: string }
export interface CollectionSlip {
  /** 留痕：经办操作人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  id: number
  collectNo: string
  customerId: number
  customerName?: string
  mode: SlipMode
  amount: number
  status: SlipStatus
  note?: string | null
  createdAt: string
  updatedAt?: string
  lines: SlipLine[]
}
export interface PaymentSlip {
  /** 留痕：经办操作人姓名（来自本机操作人绑定） */
  operatorName?: string | null
  id: number
  payNo: string
  supplierId: number
  supplierName?: string
  mode: SlipMode
  amount: number
  status: SlipStatus
  note?: string | null
  createdAt: string
  updatedAt?: string
  lines: SlipLine[]
}

export interface StatementRow {
  customerId: number
  customerName: string
  invoiced: number
  settled: number
  prepay: number
  balance: number
  buckets: { current: number; d30: number; d60: number; d90: number; d90p: number }
  overDueTotal: number
}

export interface ProfitView {
  month: string
  revenue: number
  revenueByCustomer: Array<{ customer: string; amount: number }>
  material: number
  costs: { labor: number; electricity: number; gas: number; rent: number; depreciation: number; other: number }
  manufactureCost: number
  totalCost: number
  profit: number
}

export interface MonthlyCost {
  id: number
  month: string
  category: string
  amount: number
  note?: string | null
  updatedAt?: string
}

// ---------- 开票域（I16）：与收款/核销并行的独立线 ----------

export type InvoiceType = 'vat_special' | 'vat_general' | 'electronic' | 'other'
/** red_flushed = 已红冲（跨月错票被红字发票冲减；净额统计仍计原票正数，由红字负数冲减） */
export type InvoiceStatus = 'normal' | 'voided' | 'red_flushed'
/** 订单开票状态：未开票 / 部分开票 / 已开完 */
export type InvoiceState = 'none' | 'partial' | 'done'

export interface InvoiceOrderRef { orderId: number; orderNo: string }

/** 发票（金额一律「分」） */
export interface Invoice {
  id: number
  invoiceNo: string
  invoiceType: InvoiceType
  customerId: number
  customerName?: string
  taxRate: number
  amountExclCents: number
  taxCents: number
  amountInclCents: number
  issueDate: string
  status: InvoiceStatus
  voidReason?: string | null
  voidedAt?: string | null
  operatorId?: number | null
  operatorName?: string | null
  voidOperatorId?: number | null
  voidOperatorName?: string | null
  remark?: string | null
  createdAt: string
  updatedAt?: string
  orderRefs: InvoiceOrderRef[]
  orderNos: string[]
  /** 红冲：本票是红字发票时指向的原票 id / 原票号 */
  redFlushOf?: number | null
  redFlushOfNo?: string | null
  /** 冲红原因（红字票必填） */
  redReason?: string | null
  /** 本票是红字发票（金额为负） */
  isRed?: boolean
  /** 本票为原票时：其未作废红字票号列表 / 已红冲金额（分）/ 可红冲余额（分） */
  redFlushNos?: string[]
  redFlushedCents?: number
  redRemainCents?: number
  /** 超额开票提示（仅「允许超开」放行后回传） */
  warning?: string
}

export interface InvoicePage {
  items: Invoice[]
  total: number
  page: number
  pageSize: number
}

export interface InvoiceSummaryRow {
  count: number
  amountExclCents: number
  taxCents: number
  amountInclCents: number
}

export interface InvoiceSummary extends InvoiceSummaryRow {
  from: string | null
  to: string | null
  /** 区间内「待补票号」（占位号且未作废）张数 */
  pendingNoCount: number
  byCustomer: Array<InvoiceSummaryRow & { customerId: number; customerName: string }>
  byMonth: Array<InvoiceSummaryRow & { month: string }>
}

/** 开票设置（复用 app_settings 的极简单行配置） */
export interface InvoiceSettings {
  defaultTaxRate: number
}

/** 单订单开票/收款进度（订单金额 / 已开票 / 未开票 / 已收款 / 未收） */
export interface OrderInvoiceStatus {
  orderId: number
  orderNo: string
  customerId: number
  customerName: string
  orderStatus: OrderStatus
  orderAmountCents: number
  invoicedCents: number
  uninvoicedCents: number
  overInvoiced: boolean
  invoiceState: InvoiceState
  invoiceCount: number
  voidedCount: number
  warning?: string
  receivableCents: number
  receivedCents: number
  unreceivedCents: number
  invoices: Invoice[]
}
