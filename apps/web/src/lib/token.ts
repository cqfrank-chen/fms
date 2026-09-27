/**
 * 登录态本地存储（token + 当前用户快照）。
 * 单独成模块：api.ts（读 token）与 auth.ts（登录/登出）都依赖它，避免循环引用。
 */
import type { UserRole } from './auth-types'

export interface AuthUser {
  id: number
  username: string
  displayName: string
  role: UserRole
  /** 绑定的操作人 id；null = 未绑定（留痕回退请求头 X-Operator-Id） */
  operatorId: number | null
}

const TOKEN_KEY = 'fms.token'
const USER_KEY = 'fms.user'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* 隐私模式忽略 */
  }
}

export function getUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as AuthUser
    return u && typeof u.id === 'number' && typeof u.role === 'string' ? u : null
  } catch {
    return null
  }
}

export function setUser(user: AuthUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    /* 隐私模式忽略 */
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    /* 隐私模式忽略 */
  }
}
