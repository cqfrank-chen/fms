/**
 * 金额定点工具（前端镜像，与 apps/api/src/common/money.ts 同口径）
 * ------------------------------------------------------------------
 * 金额一律以「分」为最小单位；元 ↔ 分换算与税额计算都用整数运算，
 * 保证「前端预填的税额」与「服务端强校验的税额」逐分一致（否则会被 400 拒绝）。
 */

/** 元 → 分（四舍五入到整分） */
export const toCents = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** 分 → 元 */
export const fromCents = (cents: number): number => Math.round(cents ?? 0) / 100

/** 分 → 展示文案（元，两位小数） */
export const fmtCents = (cents: number | null | undefined): string =>
  fromCents(cents ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const RATE_SCALE = 10000

/** 税率 → 万分点整数（0.13 → 1300） */
export const rateToBp = (rate: number | string | null | undefined): number => {
  const n = typeof rate === 'string' ? Number(rate) : (rate ?? 0)
  return Number.isFinite(n) ? Math.round(n * RATE_SCALE) : 0
}

/** 不含税金额（分）× 税率 → 税额（分）：整数域半进位四舍五入，与后端 taxCentsOf 完全一致 */
export const taxCentsOf = (exclCents: number, rate: number | string | null | undefined): number => {
  const p = Math.round(exclCents) * rateToBp(rate)
  const r = p % RATE_SCALE
  const q = (p - r) / RATE_SCALE
  return r * 2 >= RATE_SCALE ? q + 1 : q
}

/** 税率 → 百分比文案（0.13 → 13%） */
export const rateLabel = (rate: number): string => `${Number((rate * 100).toFixed(4))}%`

/**
 * 由「含税金额 + 税率」反解不含税金额（分）：与后端 solveExclFromIncl 同一算法/同一结果。
 * 简化交互下用户只填一个「开票金额（含税）」，税率默认 0 → 不含税 = 含税、税额 = 0。
 */
export const splitInclCents = (inclCents: number, rate: number | null | undefined): { exclCents: number; taxCents: number } => {
  const incl = Math.round(inclCents ?? 0)
  const bp = rateToBp(rate)
  const d = RATE_SCALE + bp
  const num = incl * RATE_SCALE
  const base = Math.floor(num / d)
  const rem = num - base * d
  let guess = rem * 2 >= d ? base + 1 : base
  for (let off = 0; off <= 2; off += 1) {
    const candidates = off === 0 ? [guess] : [guess - off, guess + off]
    for (const cand of candidates) {
      if (cand < 0) continue
      if (taxCentsOf(cand, rate) === incl - cand) return { exclCents: cand, taxCents: incl - cand }
    }
  }
  // 无整数分解（后端会明确拒绝）：退化为不含税=含税、税额=0，由后端校验给出中文提示
  guess = Math.max(0, guess)
  return { exclCents: incl, taxCents: 0 }
}
