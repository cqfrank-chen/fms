/**
 * 不干胶库存 · 数量调整规则（纯函数）
 * ------------------------------------------------------------------
 * 口径（与既有仓储模块一致）：
 *   · 数量是**非负整数**（张 / 卷都不允许小数与负数）；
 *   · 入库 in  → 增量 = +本次数量；领用 out → 增量 = −本次数量；
 *   · 也接受直接给**带符号的 delta**（正负均可），便于批量/接口调用；
 *   · 领用后库存**不得为负**（当前 10 张却要领 11 张 → 明确中文报错，不做静默截断）；
 *   · 上下限护栏（0 ~ 1e9）防止误填把库存写成天文数字。
 * 调整结果由服务端算好写进流水（qty_before / qty_delta / qty_after），可审计。
 */

/** 单条库存记录的数量上限（防误填；不参与业务计算，仅护栏） */
export const STICKER_MAX_QTY = 1_000_000_000;

/** 数量调整方向：in = 入库，out = 领用 */
export type StickerAdjustKind = 'in' | 'out';

export const STICKER_ADJUST_KIND_LABELS: Record<StickerAdjustKind, string> = {
  in: '入库',
  out: '领用',
};

/** 校验结果：ok=true 给算好的结果，ok=false 给中文原因（由 service 转成 400） */
export type QtyCheckResult = { ok: true; qtyAfter: number } | { ok: false; message: string };

/** 是否为合法整数（拒绝小数 / NaN / 空） */
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v);
}

/**
 * 校验并计算调整后的库存数量。
 * @param current 当前库存（必须是非负整数）
 * @param delta   增量，带符号（入库为正、领用为负），不得为 0
 */
export function checkQtyDelta(current: number, delta: number): QtyCheckResult {
  if (!isInt(current) || current < 0) return { ok: false, message: '当前库存数量异常（须为非负整数），请刷新后重试' };
  if (!isInt(delta)) return { ok: false, message: '调整数量须为整数' };
  if (delta === 0) return { ok: false, message: '调整数量不能为 0' };
  const after = current + delta;
  if (after < 0) {
    return {
      ok: false,
      message: `库存不足：当前 ${current}，本次领用 ${Math.abs(delta)}，最多可领用 ${current}`,
    };
  }
  if (after > STICKER_MAX_QTY) return { ok: false, message: `调整后数量超过上限 ${STICKER_MAX_QTY}，请核对后重试` };
  return { ok: true, qtyAfter: after };
}

/**
 * 方向 + 数量 → 带符号增量。
 * @param kind 'in' 入库（+）/ 'out' 领用（−）
 * @param qty  本次数量，必须为正整数
 */
export function kindToDelta(kind: StickerAdjustKind, qty: number): { ok: true; delta: number } | { ok: false; message: string } {
  if (kind !== 'in' && kind !== 'out') return { ok: false, message: '调整方向须为 in（入库）或 out（领用）' };
  if (!isInt(qty) || qty <= 0) return { ok: false, message: '本次数量须为正整数' };
  return { ok: true, delta: kind === 'in' ? qty : -qty };
}

/**
 * 由「方向 + 数量」或「带符号 delta」解析出最终增量（两者必给其一，都给以 delta 优先）。
 * 返回 ok=false 时 message 为中文原因。
 */
export function resolveDelta(input: { kind?: string | null; qty?: number | null; delta?: number | null }):
  { ok: true; delta: number; kind: StickerAdjustKind } | { ok: false; message: string } {
  if (input.delta !== undefined && input.delta !== null) {
    if (!isInt(input.delta)) return { ok: false, message: '调整数量须为整数' };
    if (input.delta === 0) return { ok: false, message: '调整数量不能为 0' };
    return { ok: true, delta: input.delta, kind: input.delta > 0 ? 'in' : 'out' };
  }
  if (input.kind) {
    const r = kindToDelta(input.kind as StickerAdjustKind, input.qty as number);
    if (!r.ok) return r;
    return { ok: true, delta: r.delta, kind: input.kind as StickerAdjustKind };
  }
  return { ok: false, message: '请给出调整方向（in 入库 / out 领用）与数量，或直接给出带符号的 delta' };
}
