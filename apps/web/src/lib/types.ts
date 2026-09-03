/** 与后端 schema.ts / service 返回结构对齐的类型 */

export interface Product { id: number; name: string; type: string; defaultPackaging?: string | null; defaultRouting?: string | null; safetyStock: number }
export interface Customer { id: number; name: string; contact?: string | null; settlement?: string | null; creditDays: number }
export interface Supplier { id: number; name: string; contact?: string | null; settlement?: string | null }
export interface Operator { id: number; name: string; boundPc?: string | null; note?: string | null }

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
  id: number
  orderNo: string
  customerId: number
  customerName?: string
  poNo?: string | null
  dueDate: string
  note?: string | null
  status: OrderStatus
  createdAt: string
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
  lines: PlanSheetLine[]
}

// ---------- 仓储域（I08） ----------

export type ReceiptStatus = 'draft' | 'confirmed' | 'voided'

export interface ReceiptLine {
  id: number
  receiptId?: number
  planSheetLineId: number
  productId: number
  productName?: string
  quantity: number
}

export interface GoodsReceipt {
  id: number
  receiptNo: string
  planSheetId: number
  planNo?: string
  batchNo: string
  status: ReceiptStatus
  note?: string | null
  createdAt: string
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
  shippedAt?: string | null
  generatedAmount?: number
  lines: OutboundLine[]
}

export interface IncomingGoods {
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
}

export interface Stocktake {
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
  shipNo?: string
  amount: number
  currency: string
  settledAmount: number
  status: ReceiptStatus
  dueDate?: string | null
  createdAt: string
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
  remain: number
  settled: boolean
}

export type SlipMode = 'settle' | 'prepay'
export type SlipStatus = 'confirmed' | 'voided'

export interface SlipLine { id: number; amount: number; recvNo?: string; payNo?: string }
export interface CollectionSlip {
  id: number
  collectNo: string
  customerId: number
  customerName?: string
  mode: SlipMode
  amount: number
  status: SlipStatus
  note?: string | null
  createdAt: string
  lines: SlipLine[]
}
export interface PaymentSlip {
  id: number
  payNo: string
  supplierId: number
  supplierName?: string
  mode: SlipMode
  amount: number
  status: SlipStatus
  note?: string | null
  createdAt: string
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
}
