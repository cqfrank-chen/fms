/**
 * 不干胶图片取图（登录态）
 * ------------------------------------------------------------------
 * 图片接口 GET /api/stickers/:id/image 需要登录态，而 <img src> 不会带 Authorization 头，
 * 所以统一走 fetch（带 Bearer）取 blob → createObjectURL。
 *   · 同一 id 的结果按 TTL 缓存，避免列表滚动时反复请求；
 *   · 重新上传后调用 invalidateStickerImage(id) 让缩略图刷新；
 *   · 组件卸载/换图时 revoke 旧的 objectURL，避免内存泄漏。
 */
import { useEffect, useState } from 'react'
import { getToken } from './token'

const TTL_MS = 60_000
const cache = new Map<number, { url: string; at: number }>()

/** 取图片 objectURL（带登录态；失败抛错，由调用方展示中文提示） */
export async function fetchStickerImageUrl(id: number, fresh = false): Promise<string> {
  const hit = cache.get(id)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.url
  const res = await fetch(`/api/stickers/${id}/image`, {
    headers: { Authorization: 'Bearer ' + (getToken() ?? '') },
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  if (hit) URL.revokeObjectURL(hit.url)
  cache.set(id, { url, at: Date.now() })
  return url
}

/** 图片被替换/删除后调用（下次取图重新拉） */
export function invalidateStickerImage(id: number): void {
  const hit = cache.get(id)
  if (hit) {
    URL.revokeObjectURL(hit.url)
    cache.delete(id)
  }
}

/**
 * 缩略图/大图用的取图 hook。
 * @param id 记录 id（null/undefined = 无图，直接返回 null）
 * @param version 版本号：重新上传图片后 +1 触发重新拉取
 */
export function useStickerImage(id: number | null | undefined, version = 0): { url: string | null; error: string | null; loading: boolean } {
  const [url, setUrl] = useState<string | null>(id == null ? null : (cache.get(id)?.url ?? null))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (id == null) { setUrl(null); setError(null); return }
    let alive = true
    setLoading(true)
    setError(null)
    fetchStickerImageUrl(id, version > 0)
      .then((u) => { if (alive) setUrl(u) })
      .catch((e: unknown) => { if (alive) { setUrl(null); setError((e as Error).message) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, version])

  return { url, error, loading }
}
