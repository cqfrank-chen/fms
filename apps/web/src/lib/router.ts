/**
 * 极简路径路由：本应用只有 /login（登录页）与 /（主外壳）两个路径，
 * 用 History API 代替引入 react-router（nginx 已配置 try_files → index.html，直接刷新子路径可用）。
 */
import { useEffect, useState } from 'react'

export const LOGIN_PATH = '/login'
export const HOME_PATH = '/'

export function navigate(path: string, replace = false): void {
  if (window.location.pathname === path) return
  if (replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  // history.pushState 不触发 popstate，手动派发一次让 usePathname 感知
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onChange)
    return () => window.removeEventListener('popstate', onChange)
  }, [])
  return path
}
