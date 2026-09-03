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
