/**
 * 不干胶库存 · 标题生成规则的**前端镜像**（仅用于界面实时预览）。
 * ------------------------------------------------------------------
 * 权威实现始终在后端 apps/api/src/stickers/sticker-title.ts（保存时以服务端为准）；
 * 这里保持同一套规则：品牌 + 样式/系列 + 规格，缺项省略，全缺给占位标题。
 */
export const STICKER_TITLE_FALLBACK = '未命名不干胶'

export const STICKER_FIELD_LABELS: Record<'brand' | 'style' | 'sizeSpec', string> = {
  brand: '品牌',
  style: '样式/系列',
  sizeSpec: '规格/尺寸',
}

const PLACEHOLDERS = new Set([
  '', '-', '--', '---', '—', '–', '/', 'n/a', 'na', 'null', 'nil', 'none', 'undefined', 'unknown',
  '未知', '不详', '不明', '不清楚', '无', '没有', '暂无', '待定', '待补', '空', '略', '?', '？', '...',
])

/** 与后端 cleanStickerText 同口径：压缩空白 + 剔除纯占位写法 */
export function cleanStickerText(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return PLACEHOLDERS.has(s.toLowerCase()) ? '' : s
}

/** 标题预览（品牌 + 样式/系列 + 规格；缺项省略）+ 缺项中文名 */
export function previewStickerTitle(input: { brand?: string; style?: string; sizeSpec?: string }): { title: string; missing: string[] } {
  const parts: string[] = []
  const missing: string[] = []
  for (const [key, label] of [['brand', '品牌'], ['style', '样式/系列'], ['sizeSpec', '规格/尺寸']] as const) {
    const v = cleanStickerText(input[key])
    if (v) parts.push(v)
    else missing.push(label)
  }
  return { title: parts.length ? parts.join(' ') : STICKER_TITLE_FALLBACK, missing }
}
