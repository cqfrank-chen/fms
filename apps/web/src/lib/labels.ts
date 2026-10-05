/** 枚举 → 中文文案映射（与后端 schema.ts 词表一一对应） */
export const PRODUCT_TYPE_LABEL: Record<string, string> = {
  uk_acetylene: '英式乙炔',
  uk_propane: '英式丙烷',
  us_acetylene: '美式乙炔',
  us_propane: '美式丙烷',
  // 待定：占位产品「（未建档产品·待补）」专用（I17 甲方裁定③：不再借用 uk_acetylene）
  tbd: '待定',
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

/**
 * 待补项编码（与后端 apps/api/src/orders/pending-items.ts 的 PENDING_CODES 一一对应）
 * 界面按 code 精确定位「缺什么」并做醒目提示（列表摘要 / 展开明细的待补标记）；
 * message 是后端给的中文诊断，界面只负责展示，**不**在前端重写文案。
 */
export const PENDING_CODE = {
  /** 客户未建档（customer_id 指向占位档案） */
  CUSTOMER_NOT_FILED: 'customer_not_filed',
  /** 缺交期（due_date 是哨兵日，界面显示「待定」） */
  DUE_DATE_MISSING: 'due_date_missing',
  /** 整单没有产品行 */
  NO_PRODUCT_LINES: 'no_product_lines',
  /** 行级待补汇总（单头可见，明细在行上） */
  LINE_PENDING: 'line_pending',
  /** 行级：缺单价 */
  PRICE_MISSING: 'price_missing',
  /** 行级：缺数量 */
  QUANTITY_MISSING: 'quantity_missing',
  /** 行级：产品未建档（product_id 指向占位产品） */
  PRODUCT_NOT_FILED: 'product_not_filed',
} as const

/** 包装类型（复合勾选） */
export const PACK_LABEL: Record<string, string> = {
  box: '包装盒',
  bag: '套袋',
  carton: '纸箱',
  label: '不干胶',
}

/**
 * 币种（I17 甲方裁定）：统一归一为 CNY —— RMB / RMB¥ / ￥ / ¥ / 人民币 一律按 CNY 展示。
 * RMB 仅作为历史数据兼容项保留（新写入一律 CNY，见后端 common/currency.ts）。
 */
export const CURRENCY_LABEL: Record<string, string> = {
  CNY: 'CNY',
  RMB: 'CNY',
  USD: 'USD',
}

/** 币种下拉可选项（规范值；历史 RMB 行在展示层已归一到 CNY） */
export const CURRENCY_OPTIONS = [
  { value: 'CNY', label: 'CNY' },
  { value: 'USD', label: 'USD' },
]

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

/** 开票：发票类型（I16，与后端 schema.INVOICE_TYPES 一一对应） */
export const INVOICE_TYPE_LABEL: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_general: '增值税普通发票',
  electronic: '电子发票',
  other: '其他',
}

/** 开票：发票状态（red_flushed = 已红冲：跨月错票被红字发票冲减） */
export const INVOICE_STATUS_LABEL: Record<string, string> = {
  normal: '正常',
  voided: '已作废',
  red_flushed: '已红冲',
}

/** 开票：默认税率可选项（设置页；与后端 ALLOWED_DEFAULT_TAX_RATES 一致） */
export const DEFAULT_TAX_RATE_OPTIONS = [
  { value: 0, label: '0%（免税/出口，默认）' },
  { value: 0.01, label: '1%（小规模优惠）' },
  { value: 0.06, label: '6%（现代服务）' },
  { value: 0.09, label: '9%（交通运输等）' },
  { value: 0.13, label: '13%（货物）' },
]

/** 开票：订单开票状态三态（简化交互：未开票 / 部分开票 / 已开完） */
export const INVOICE_STATE_LABEL: Record<string, string> = {
  none: '未开票',
  partial: '部分开票',
  done: '已开完',
}

/** 开票状态标签配色（AntD Tag color） */
export const INVOICE_STATE_COLOR: Record<string, string> = {
  none: 'default',
  partial: 'orange',
  done: 'success',
}

/** 占位票号前缀（后端缺省自动生成「待补号-YYYYMMDD-NN」，可随后补录） */
export const INVOICE_PLACEHOLDER_PREFIX = '待补号-'

/** 常用税率（可选择的其他税率用输入框自填） */
export const TAX_RATE_OPTIONS = [
  { value: 0.13, label: '13%（货物）' },
  { value: 0.09, label: '9%（交通运输等）' },
  { value: 0.06, label: '6%（现代服务）' },
  { value: 0.01, label: '1%（小规模优惠）' },
  { value: 0, label: '0%（免税/出口）' },
]

/** 不干胶数量调整方向（与后端 sticker-qty.ts 的 STICKER_ADJUST_KINDS 一一对应） */
export const STICKER_ADJUST_LABEL: Record<string, string> = {
  in: '入库',
  out: '领用',
}

/** 不干胶单位可选项（默认张；卷装可改） */
export const STICKER_UNIT_OPTIONS = [
  { value: '张', label: '张' },
  { value: '卷', label: '卷' },
]

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
