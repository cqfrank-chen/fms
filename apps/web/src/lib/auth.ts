/**
 * 登录鉴权（前端）：登录 / 登出 / 当前用户 / 改密 + 角色可见页面表。
 * token 与用户快照存 localStorage（见 ./token.ts），api.ts 统一附加 Authorization 头。
 */
import { api } from './api'
import { HOME_PATH, LOGIN_PATH, navigate } from './router'
import { clearAuth, getUser, setToken, setUser } from './token'
import type { AuthUser } from './token'
import type { UserRole } from './auth-types'
import type { PageKey } from './nav'

export type { AuthUser } from './token'
export type { UserRole } from './auth-types'
export { ROLE_LABELS, ROLE_OPTIONS, USER_ROLES } from './auth-types'

/** 登录：成功写入 token 与用户快照返回用户；失败抛错（401 → 用户名或密码错误） */
export async function login(username: string, password: string): Promise<AuthUser> {
  const r = await api<{ token: string; user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: { username, password },
    skipAuth: true,
  })
  setToken(r.token)
  setUser(r.user)
  return r.user
}

/** 拉取当前登录用户（刷新页面时回填顶栏与菜单权限；401 由 api.ts 统一登出跳转） */
export async function fetchMe(): Promise<AuthUser> {
  const u = await api<AuthUser>('/auth/me')
  setUser(u)
  return u
}

/** 修改自己的密码（旧密码 + 新密码） */
export function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: true }> {
  return api<{ ok: true }>('/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } })
}

/** 退出登录：清本地登录态并回到登录页 */
export function logout(): void {
  clearAuth()
  navigate(LOGIN_PATH, true)
}

export const currentUser = getUser

/**
 * 页面可见角色（admin 恒可见）。
 * 与后端权限矩阵（apps/api/src/auth/permissions.ts）保持一致的裁剪：
 *   · workshop 不给 账务 / 设置 / 订单维护（只报工与看排程）
 *   · warehouse 不给 排程 / 账务 / 设置
 *   · accounting 只给 账目统计（+ 订单/首页只读）
 */
export const PAGE_ROLES: Record<PageKey, UserRole[]> = {
  overview: ['admin', 'planner', 'warehouse', 'accounting', 'workshop'],
  orders: ['admin', 'planner', 'warehouse', 'accounting'],
  plans: ['admin', 'planner', 'warehouse', 'workshop'],
  schedule: ['admin', 'planner', 'workshop'],
  warehouse: ['admin', 'planner', 'warehouse'],
  // 不干胶库存（I18）：仓储维护（入库/领用/建档），计划员可查看
  //（与后端 @Roles('admin','warehouse') 的写权限对齐；读操作所有登录角色可用）
  stickers: ['admin', 'planner', 'warehouse'],
  accounting: ['admin', 'accounting'],
  // 报价记录（I17）：计划员维护价格、账务可只读查看（与后端 @Roles('admin','planner') 写权限对齐）
  quotes: ['admin', 'planner', 'accounting'],
  ai: ['admin', 'planner', 'accounting'],
  setup: ['admin'],
}

/** 该角色是否可访问某页面（admin 全权） */
export function canAccessPage(role: UserRole, page: PageKey): boolean {
  if (role === 'admin') return true
  return (PAGE_ROLES[page] ?? []).includes(role)
}

/** 登录后默认落地页：首页概览（若角色不可见则取第一个可见页） */
export function defaultPage(role: UserRole): PageKey {
  if (canAccessPage(role, 'overview')) return 'overview'
  const found = (Object.keys(PAGE_ROLES) as PageKey[]).find((p) => canAccessPage(role, p))
  return found ?? 'overview'
}

export { HOME_PATH, LOGIN_PATH }
