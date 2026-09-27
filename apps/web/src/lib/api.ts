import { message } from 'antd'
import { getOperatorId } from './operator'
import { getToken, clearAuth } from './token'
import { LOGIN_PATH, navigate } from './router'

/** 统一 API 请求封装（fetch + JSON + 错误归一 + 登录态注入） */
const API = '/api'

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  /** 免登录接口（如 /auth/login）：不带 token，401 也不触发登出跳转（否则会把「密码错」当登录失效） */
  skipAuth?: boolean
}

/** 401 处理：清登录态 + 跳登录页（同一时刻只提示/跳转一次，避免并发请求刷屏） */
let redirecting = false
function onUnauthorized(): void {
  clearAuth()
  if (redirecting) return
  redirecting = true
  message.error('登录已失效，请重新登录')
  navigate(LOGIN_PATH, true)
  window.setTimeout(() => { redirecting = false }, 800)
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  // 留痕：优先用登录用户绑定的操作人（后端按 req.user.operatorId 取值），
  // 未绑定时后端回退该请求头（向后兼容旧版「本机操作人」）
  const opId = getOperatorId()
  const token = options.skipAuth ? null : getToken()
  const res = await fetch(API + path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opId ? { 'X-Operator-Id': String(opId) } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (res.status === 401 && !options.skipAuth) {
    onUnauthorized()
    throw new Error('登录已失效，请重新登录')
  }
  if (!res.ok) {
    // NestJS ValidationPipe 400 返回 { message: string[] }；统一取首条
    const text = await res.text()
    let detail = 'HTTP ' + res.status
    try {
      const json = JSON.parse(text)
      if (Array.isArray(json.message) && json.message.length) detail = json.message[0]
      else if (typeof json.message === 'string') detail = json.message
    } catch {
      /* 非 JSON 忽略 */
    }
    throw new Error(detail)
  }
  if (res.status === 204) return undefined as T
  // 成功但空 body（如部分 DELETE 返回 200 无内容）→ 判空返回，避免 res.json() 抛 SyntaxError
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as Promise<T>
}

/**
 * 载入下拉/筛选选项等次要数据：失败时明确提示，避免「静默空下拉」让人误以为无数据。
 * （Review 中危：关键初始化 catch(() => {}) 吞错）
 */
export function loadOptions<T>(path: string, apply: (rows: T[]) => void, label: string): void {
  api<T[]>(path)
    .then(apply)
    .catch((e: unknown) => message.error(label + '加载失败：' + (e as Error).message + '；下拉可能为空，请刷新重试'))
}
