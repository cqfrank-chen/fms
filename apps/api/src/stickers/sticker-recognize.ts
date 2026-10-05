import { buildStickerTitle, cleanRemarkText, cleanStickerText } from './sticker-title';
import type { StickerField } from './sticker-title';

/**
 * 不干胶识图（视觉通道）· 提示词与结果解析
 * ------------------------------------------------------------------
 * 铁的纪律（甲方要求）：**只提取图上真实可见的信息，缺的一律留空，绝不臆造**。
 * 所以提示词里明确要求「看不到就返回空字符串」，解析层再把 未知/无/N/A/null 之类的
 * 占位写法统一清成空（cleanStickerText），最后由 sticker-title 的规则拼标题并在备注里说明缺什么。
 */

/** 视觉提取的字段（与 sticker-title 的组合字段对齐，外加数量/单位/客户/备注/原文） */
export interface StickerExtract {
  brand: string;
  style: string;
  sizeSpec: string;
  qty: number | null;
  unit: string;
  customer: string;
  remark: string;
  rawText: string;
}

/** 本业务关心的字段名（用于从模型回复的多个 JSON 里挑出真正的提取结果） */
export const EXTRACT_KEYS = ['brand', 'style', 'sizeSpec', 'qty', 'unit', 'customer', 'remark', 'rawText'] as const;

/** 视觉通道提示词：中文、严格 JSON、缺失留空、不得编造 */
export const STICKER_VISION_PROMPT = [
  '你是不干胶标签（贴纸/标贴/唛头）的识图录入助手。请阅读这张图片，抽取标签上的信息。',
  '',
  '【最重要的纪律】只填写图片中**真实可见**的内容；看不到或不确定的字段一律返回**空字符串**。',
  '严禁猜测、补全、翻译或按经验编造任何字段（宁缺勿编）。',
  '',
  '严格返回如下 JSON（不要输出多余文字，不要包 markdown 代码块）：',
  '{',
  '  "brand": "品牌 / 商标 / 客户标志上的名字",',
  '  "style": "样式 / 系列（如 正唛、白盒贴、横版、6290NX 系列）",',
  '  "sizeSpec": "规格 / 尺寸（如 20×30mm、直径 40mm；含印刷的型号尺寸）",',
  '  "qty": "标签上印刷的数量（纯数字；没有印刷数量就填空字符串）",',
  '  "unit": "单位（张 / 卷；看不出就填空字符串）",',
  '  "customer": "图上出现的客户名 / 公司名（没有就填空字符串）",',
  '  "remark": "其它值得记录的信息：材质、颜色、印刷要求、贴法、语言等（没有就填空字符串）",',
  '  "rawText": "图上所有可辨认文字的原文，逐行用 \\n 分隔（原样抄录，不要翻译、不要总结）"',
  '}',
].join('\n');

/**
 * 从 '{' 开始做**括号配对扫描**（跳过字符串内的花括号与转义），返回配对 '}' 的下标；未配对返回 -1。
 * 不能用 lastIndexOf('}') 代替：模型偶尔会先回一段噪音再回 JSON（见下）。
 */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 取出模型回复里的 JSON 对象（去掉 markdown 代码围栏后，逐个 '{' 起点尝试）。
 * 为什么不是「第一个 { 到最后一个 }」：实测真实视觉模型（DeepSeek 兼容通道）会先回一段
 * 参数回声（如 {"type": "json_object"}）再回真正的 JSON，粗暴切片会拼成非法 JSON 而整体解析失败。
 * 这里逐个起点试、配对括号切片，谁能解析出对象就用谁；都解析不出返回 null（上层给中文提示，绝不臆造）。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const candidates: Record<string, unknown>[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end < 0) continue;
    try {
      const v = JSON.parse(s.slice(i, end + 1)) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) candidates.push(v as Record<string, unknown>);
    } catch {
      /* 该起点不是合法 JSON，继续试下一个 */
    }
  }
  if (!candidates.length) return null;
  // 优先选「含本业务字段」的候选：模型可能先回一段参数回声（{"type":"json_object"}）再回真正的 JSON
  const hit = candidates.find((c) => EXTRACT_KEYS.some((k) => k in c));
  if (hit) return hit;
  // 都不含业务字段时，退回最长的那个候选（信息量最大），仍由上层按「缺项」处理，不臆造
  return candidates.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
}

/** 数量文本 → 非负整数；解析不出来返回 null（**不猜**） */
export function parseVisionQty(v: unknown): number | null {
  const s = cleanStickerText(v).replace(/[,，\s]/g, '');
  if (!s) return null;
  const m = s.match(/^\d+(?:\.0+)?$/);
  if (!m) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * 解析视觉通道返回的 JSON → 归一后的提取结果。
 * 解析失败（模型没按 JSON 回 / 回了空）时返回全空结果 + rawText=原文，
 * 由上层给出「识图结果为空，请手工填写」的中文提示（绝不拿原文硬凑字段）。
 */
export function parseStickerExtract(text: string): { extract: StickerExtract; parsed: boolean } {
  const obj = extractJsonObject(text);
  const empty: StickerExtract = { brand: '', style: '', sizeSpec: '', qty: null, unit: '', customer: '', remark: '', rawText: '' };
  if (!obj) {
    // 非 JSON：rawText 原样保留（含换行），字段全空 —— 绝不拿原文硬凑字段
    return { extract: { ...empty, rawText: cleanRemarkText(text) }, parsed: false };
  }
  const unit = cleanStickerText(obj.unit);
  return {
    parsed: true,
    extract: {
      brand: cleanStickerText(obj.brand),
      style: cleanStickerText(obj.style),
      sizeSpec: cleanStickerText(obj.sizeSpec),
      qty: parseVisionQty(obj.qty),
      unit: unit || '张',
      customer: cleanStickerText(obj.customer),
      remark: cleanStickerText(obj.remark),
      // rawText 是「逐行抄录的原文」，保留换行（其余字段是单行值，走 cleanStickerText）
      rawText: cleanRemarkText(obj.rawText) || cleanRemarkText(text),
    },
  };
}

/** 识别建议：标题按规则生成，缺项在 note 里说明 */
export interface StickerSuggestion extends StickerExtract {
  title: string;
  missing: StickerField[];
  note: string;
}

/** 由提取结果生成「建议建档字段」（标题 = 品牌 + 样式/系列 + 规格，缺项省略并说明） */
export function buildSuggestion(extract: StickerExtract): StickerSuggestion {
  const t = buildStickerTitle(extract);
  return { ...extract, title: t.title, missing: t.missing, note: t.note };
}

/** 空建议（识图不可用时返回，让用户纯手工填写） */
export function emptySuggestion(): StickerSuggestion {
  return buildSuggestion({ brand: '', style: '', sizeSpec: '', qty: null, unit: '张', customer: '', remark: '', rawText: '' });
}
