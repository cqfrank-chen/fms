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
