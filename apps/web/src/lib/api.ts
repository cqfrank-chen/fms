import { message } from 'antd'

/** 统一 API 请求封装（fetch + JSON + 错误归一） */
const API = '/api'

export async function api<T = unknown>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
    // NestJS ValidationPipe 400 返回 { message: string[] }；统一取首条
    const text = await res.text()
    let detail = `HTTP ${res.status}`
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
    .catch((e: unknown) => message.error(`${label}加载失败：${(e as Error).message}；下拉可能为空，请刷新重试`))
}
