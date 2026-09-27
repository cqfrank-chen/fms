/** 与后端 schema.ts / service 返回结构对齐的类型 */

export interface Product { id: number; name: string; type: string; defaultPackaging?: string | null; defaultRouting?: string | null; safetyStock: number; createdAt?: string; updatedAt?: string }
export interface Customer { id: number; name: string; contact?: string | null; settlement?: string | null; creditDays: number; createdAt?: string; updatedAt?: string }
export interface Supplier { id: number; name: string; contact?: string | null; settlement?: string | null; createdAt?: string; updatedAt?: string }
export interface Operator { id: number; name: string; boundPc?: string | null; note?: string | null; createdAt?: string; updatedAt?: string }

export type PackType = 'box' | 'bag' | 'carton' | 'label'
export type PackagingSpec = Partial<Record<PackType, string>>

export type OrderStatus = 'draft' | 'confirmed' | 'production' | 'completed' | 'cancelled'
export type PlanStatus = 'draft' | 'confirmed' | 'production' | 'completed' | 'cancelled'

export interface OrderLine {
  id?: number
  productId: number
  productName?: string
  quantity: number
  unitPrice: number
  currency: 'RMB' | 'USD'
  engraving?: string | null
  packaging?: PackagingSpec | null
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
  note?: string | null
  status: OrderStatus
  createdAt: string
  updatedAt?: string
  totalAmount?: number // 后端 attachLines 按行 Σ(数量×单价)
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
