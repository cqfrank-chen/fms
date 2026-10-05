/** 侧边导航页面键：App 与各页面共用，放在 lib 避免循环引用 */
export type PageKey =
  | 'overview'
  | 'orders'
  | 'plans'
  | 'schedule'
  | 'warehouse'
  | 'accounting'
  | 'quotes'
  | 'ai'
  | 'setup'
