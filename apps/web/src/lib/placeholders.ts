import { useCallback, useEffect, useState } from 'react'

/**
 * 「显示占位档案」开关（I17 甲方裁定②）
 * ------------------------------------------------------------------
 * 裁定：占位档案（未建档客户·待补 / 未建档产品·待补）在前端客户/产品/订单相关列表**默认隐藏**，
 * 并提供「显示占位档案」开关供排查。
 *
 * 实现口径：
 *   · 开关状态存 localStorage（fms.showPlaceholders），刷新后保持；
 *   · 打开时给列表请求带上 includePlaceholders=1（后端再放行占位档案）；
 *   · 同页多个组件共享同一开关（模块级订阅），任一处切换，其它处同步刷新。
 */
export const PLACEHOLDER_NAMES = ['（未建档客户·待补）', '（未建档产品·待补）']

/** 开关说明（界面 Tooltip 直接展示，避免口径靠猜） */
export const PLACEHOLDER_HINT =
  '占位档案「（未建档客户·待补）」「（未建档产品·待补）」不是真实档案：' +
  '识单落草稿时客户/产品未建档，系统用它们占位以便落库（原文另存，可人工建档后改指）。' +
  '默认隐藏；打开此开关可查看（仅供排查，不要把它们当成真实客户/产品）。' +
  '「仅看有未补全项的草稿单」筛选不受此开关限制（补全工作流必须能看到这些草稿）。'

const KEY = 'fms.showPlaceholders'
const listeners = new Set<(v: boolean) => void>()

export function readShowPlaceholders(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function writeShowPlaceholders(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式下不可写，忽略（仅本次会话生效） */
  }
  listeners.forEach((fn) => fn(v))
}

/** 共享开关：返回 [是否显示占位档案, 设置函数]，多处使用自动同步 */
export function useShowPlaceholders(): [boolean, (v: boolean) => void] {
  const [show, setShow] = useState<boolean>(readShowPlaceholders)
  useEffect(() => {
    const fn = (v: boolean) => setShow(v)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  const set = useCallback((v: boolean) => writeShowPlaceholders(v), [])
  return [show, set]
}

/** 给列表 URL 追加 includePlaceholders=1（开关打开时） */
export function withPlaceholders(url: string, show: boolean): string {
  if (!show) return url
  return url + (url.includes('?') ? '&' : '?') + 'includePlaceholders=1'
}
