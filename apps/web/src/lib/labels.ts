/** 枚举 → 中文文案映射（与后端 schema.ts 词表一一对应） */
export const PRODUCT_TYPE_LABEL: Record<string, string> = {
  uk_acetylene: '英式乙炔',
  uk_propane: '英式丙烷',
  us_acetylene: '美式乙炔',
  us_propane: '美式丙烷',
}

export const SETTLEMENT_LABEL: Record<string, string> = {
  deposit_30_balance_before_ship: '30%定金+70%发货前',
  monthly_30: '月结30天',
  monthly_60: '月结60天',
  before_ship: '发货前付清',
  prepay_30: '预付30%',
  monthly: '月结',
  cash: '现结',
}

/** 订单/计划单五态 */
export const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  production: '生产中',
  completed: '已完成',
  cancelled: '已取消',
  voided: '已作废',
}

/** 包装类型（复合勾选） */
export const PACK_LABEL: Record<string, string> = {
  box: '包装盒',
  bag: '套袋',
  carton: '纸箱',
  label: '不干胶',
}

/** 币种 */
export const CURRENCY_LABEL: Record<string, string> = {
  RMB: 'RMB',
  USD: 'USD',
}

/** 仓储单据三态（入库/盘点/应收/应付） */
export const RECEIPT_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  voided: '已冲销',
}

/** OQC 判定 */
export const OQC_LABEL: Record<string, string> = {
  pending: '待检',
  passed: '合格放行',
  exempt: '免检',
}

/** 出库单状态 */
export const OUTBOUND_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  pending: 'OQC 待检',
  shipped: '已出库',
  voided: '已冲销',
}

/** IQC 检验状态（一期线下预留） */
export const IQC_LABEL: Record<string, string> = {
  pending: '待检（线下纸质）',
  passed: '合格',
}

/** 收付款模式 */
export const SLIP_MODE_LABEL: Record<string, string> = {
  settle: '核销',
  prepay: '预收/预付',
  apply: '预收/预付冲抵',
}

/** 月度成本六类 */
export const COST_CATEGORY_LABEL: Record<string, string> = {
  labor: '人工',
  electricity: '电费',
  gas: '燃气',
  rent: '房租',
  depreciation: '折旧',
  other: '其他',
}
export const COST_CATEGORY_ORDER = ['labor', 'electricity', 'gas', 'rent', 'depreciation', 'other']
