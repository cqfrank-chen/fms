/**
 * 不干胶库存 · 标题生成规则（纯函数，**绝不臆造**）
 * ------------------------------------------------------------------
 * 甲方口径：库存标题 = 「品牌 + 样式/系列 + 规格」的组合。
 *   · 有哪几项就拼哪几项，中间一个空格；
 *   · 缺的项**自动省略**，并在备注里写清楚「缺什么」，供人工补全；
 *   · 全缺时不编名字，给一个明确的中文占位「未命名不干胶」；
 *   · 识别到的占位词（未知 / 无 / N/A / null…）一律当「没有」，不算有效字段。
 * 规则是纯函数：service 与前端展示、单测共用同一实现，保证「界面看到的标题」就是「入库的标题」。
 */

/** 参与标题组合的三个业务字段 */
export type StickerField = 'brand' | 'style' | 'sizeSpec';

/** 字段中文名（备注里的缺项说明、前端标签共用） */
export const STICKER_FIELD_LABELS: Record<StickerField, string> = {
  brand: '品牌',
  style: '样式/系列',
  sizeSpec: '规格/尺寸',
};

/** 标题组合顺序（品牌 → 样式/系列 → 规格） */
export const STICKER_TITLE_ORDER: StickerField[] = ['brand', 'style', 'sizeSpec'];

/** 无有效字段时的占位标题（明确表示「没识别出来」，不编造） */
export const STICKER_TITLE_FALLBACK = '未命名不干胶';

/**
 * 视为「没有这项」的占位写法（大小写不敏感，去空格后比对）。
 * 视觉模型在信息缺失时常回 "无" / "N/A" / "null" / "unknown"，这些都**不能**当成品牌或规格写进标题。
 */
const PLACEHOLDER_VALUES = new Set([
  '', '-', '--', '---', '—', '–', '/', 'n/a', 'na', 'null', 'nil', 'none', 'undefined', 'unknown',
  '未知', '不详', '不明', '不清楚', '无', '没有', '暂无', '待定', '待补', '空', '略', '?', '？', '...',
]);

/**
 * 文本归一：去首尾空白（含全角空格）、压缩内部连续空白、剔除纯占位写法。
 * 返回 '' 表示「这项没有有效信息」。**不做任何联想补全**。
 */
export function cleanStickerText(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return PLACEHOLDER_VALUES.has(s.toLowerCase()) ? '' : s;
}

/**
 * 备注文本归一：**保留换行**（备注天然是多行的：人工备注 / 缺项说明 / AI 原文各占一行），
 * 每行内部压缩空白、丢掉空行与纯占位行。
 */
export function cleanRemarkText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\u3000/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !PLACEHOLDER_VALUES.has(line.toLowerCase()))
    .join('\n');
}

export interface StickerTitleInput {
  brand?: unknown;
  style?: unknown;
  sizeSpec?: unknown;
}

export interface StickerTitleResult {
  /** 组合出来的标题（全缺时为 STICKER_TITLE_FALLBACK，不编造） */
  title: string;
  /** 实际参与组合的片段（按 STICKER_TITLE_ORDER 顺序） */
  parts: string[];
  /** 缺的字段（按 STICKER_TITLE_ORDER 顺序） */
  missing: StickerField[];
  /** 中文缺项说明（没有缺项时为空串） */
  note: string;
}

/**
 * 生成库存标题。
 *   brand='GLOOR' style='白盒贴' sizeSpec='' → { title: 'GLOOR 白盒贴', missing: ['sizeSpec'], note: '识别缺失：规格/尺寸…' }
 *   brand='' style='' sizeSpec=''           → { title: '未命名不干胶', missing: [三项], note: '…' }
 */
export function buildStickerTitle(input: StickerTitleInput): StickerTitleResult {
  const cleaned: Record<StickerField, string> = {
    brand: cleanStickerText(input.brand),
    style: cleanStickerText(input.style),
    sizeSpec: cleanStickerText(input.sizeSpec),
  };
  const parts: string[] = [];
  const missing: StickerField[] = [];
  for (const f of STICKER_TITLE_ORDER) {
    if (cleaned[f]) parts.push(cleaned[f]);
    else missing.push(f);
  }
  const title = parts.length ? parts.join(' ') : STICKER_TITLE_FALLBACK;
  return { title, parts, missing, note: missingNote(missing, parts.length === 0) };
}

/** 缺项说明文案（缺项为空时返回 ''） */
function missingNote(missing: StickerField[], allMissing: boolean): string {
  if (!missing.length) return '';
  const names = missing.map((f) => STICKER_FIELD_LABELS[f]).join('、');
  if (allMissing) return `图片未识别到任何有效信息（缺：${names}），标题为占位，请人工补全后保存`;
  return `图片未识别到：${names}，标题已自动省略该项，可人工补全`;
}

/**
 * 拼备注：在人工备注之外追加「识别缺项说明」与「AI 提取原文复核提示」。
 * 幂等：同一段说明不会重复追加（重复调用 PUT 不会越写越长）。
 */
export function buildStickerRemark(opts: {
  remark?: unknown;
  missing?: StickerField[];
  allMissing?: boolean;
  rawText?: unknown;
  /** 视觉通道的降级/失败说明（识图不可用时如实写入，便于事后复核） */
  aiNote?: string;
}): string {
  const base = cleanRemarkText(opts.remark);
  const chunks: string[] = [];
  if (base) chunks.push(base);
  // 幂等：已经写过的段落（人工备注里带上了）不重复追加，避免反复 PUT 越写越长
  const push = (s: string) => {
    if (!s) return;
    if (chunks.includes(s) || base.includes(s)) return;
    chunks.push(s);
  };
  push(missingNote(opts.missing ?? [], !!opts.allMissing));
  push(cleanRemarkText(opts.aiNote));
  const raw = cleanRemarkText(opts.rawText);
  if (raw) push(`AI 提取原文：${raw}`);
  return chunks.join('\n');
}

/**
 * 判断当前标题是否还是「系统按字段自动生成的标题」。
 * 用于编辑时决定「要不要跟着字段重算标题」：用户手动改过的标题**绝不覆盖**。
 */
export function isAutoTitle(currentTitle: unknown, fields: StickerTitleInput): boolean {
  const cur = cleanStickerText(currentTitle);
  if (!cur) return true;
  return cur === buildStickerTitle(fields).title;
}
