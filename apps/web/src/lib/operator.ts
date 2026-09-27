/**
 * 当前操作人（免登录留痕，spec §9）：本机绑定。
 * 选择后存入 localStorage，并由 lib/api.ts 以 X-Operator-Id 头随每个请求发送，
 * 后端把该值写入订单/报工/出入库/收付款等单据，实现"谁做的"可追溯。
 */
const KEY = 'fms.operatorId'

export function getOperatorId(): number | null {
  try {
    const v = localStorage.getItem(KEY)
    return v && /^\d+$/.test(v) ? Number(v) : null
  } catch {
    return null
  }
}

export function setOperatorId(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(id))
  } catch {
    /* 隐私模式忽略 */
  }
}
