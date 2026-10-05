import {
  STICKER_TITLE_FALLBACK, buildStickerRemark, buildStickerTitle, cleanStickerText, isAutoTitle,
} from './sticker-title';
import { buildSuggestion, extractJsonObject, parseStickerExtract, parseVisionQty } from './sticker-recognize';

/**
 * 不干胶标题生成规则单测（I18）
 * 覆盖：正常组合 / 缺项省略 / 全缺占位 / 占位词清理 / 绝不臆造 / 备注缺项说明幂等。
 */
describe('不干胶 · 标题生成规则', () => {
  it('三项齐全 → 品牌 + 样式/系列 + 规格，单空格拼接', () => {
    const r = buildStickerTitle({ brand: 'GLOOR', style: '白盒贴', sizeSpec: '20×30mm' });
    expect(r.title).toBe('GLOOR 白盒贴 20×30mm');
    expect(r.missing).toEqual([]);
    expect(r.note).toBe('');
  });

  it('缺规格 → 自动省略该项，标题不含占位符，并在备注里说明缺什么', () => {
    const r = buildStickerTitle({ brand: 'GLOOR', style: '白盒贴', sizeSpec: '' });
    expect(r.title).toBe('GLOOR 白盒贴');
    expect(r.missing).toEqual(['sizeSpec']);
    expect(r.note).toContain('规格/尺寸');
    expect(r.title).not.toContain('未知');
  });

  it('缺品牌与规格 → 只留样式，缺项顺序按 品牌 → 样式/系列 → 规格', () => {
    const r = buildStickerTitle({ brand: '   ', style: '正唛', sizeSpec: null });
    expect(r.title).toBe('正唛');
    expect(r.missing).toEqual(['brand', 'sizeSpec']);
    expect(r.note).toBe('图片未识别到：品牌、规格/尺寸，标题已自动省略该项，可人工补全');
  });

  it('全缺 → 不编造名称，用明确的中文占位标题 + 全缺说明', () => {
    const r = buildStickerTitle({});
    expect(r.title).toBe(STICKER_TITLE_FALLBACK);
    expect(r.missing).toEqual(['brand', 'style', 'sizeSpec']);
    expect(r.note).toContain('未识别到任何有效信息');
  });

  it('占位词（未知/无/N/A/null/待定/？）一律当没有，不写进标题', () => {
    for (const v of ['未知', '无', 'N/A', 'n/a', 'null', 'undefined', '待定', '？', '-', '---', '　']) {
      expect(cleanStickerText(v)).toBe('');
    }
    const r = buildStickerTitle({ brand: 'VICTOR', style: '无', sizeSpec: 'N/A' });
    expect(r.title).toBe('VICTOR');
    expect(r.missing).toEqual(['style', 'sizeSpec']);
  });

  it('只做拼接与归一，不臆造：图上没给客户/数量，标题里也不会冒出来', () => {
    const r = buildStickerTitle({ brand: 'INFRA', style: '', sizeSpec: '' });
    expect(r.title).toBe('INFRA');
    expect(r.title).not.toMatch(/客户|数量|张|卷/);
  });

  it('文本归一：首尾空白与内部连续空白压缩，全角空格按空白处理', () => {
    expect(cleanStickerText('  GLOOR   4734P  ')).toBe('GLOOR 4734P');
    expect(cleanStickerText('GLOOR\u3000\u30004734P')).toBe('GLOOR 4734P');
  });

  it('isAutoTitle：与自动生成一致才算「未手工改过」，手工命名的标题不被覆盖', () => {
    expect(isAutoTitle('GLOOR 白盒贴', { brand: 'GLOOR', style: '白盒贴' })).toBe(true);
    expect(isAutoTitle('客户指定的名字', { brand: 'GLOOR', style: '白盒贴' })).toBe(false);
    expect(isAutoTitle('', { brand: 'GLOOR' })).toBe(true);
  });

  it('备注拼接：人工备注 + 缺项说明 + AI 原文；重复调用不重复追加（幂等）', () => {
    const once = buildStickerRemark({ remark: '红色横版', missing: ['sizeSpec'], rawText: 'GLOOR\n4734P' });
    expect(once).toContain('红色横版');
    expect(once).toContain('规格/尺寸');
    // rawText 的多行原文在备注里**保留换行**（原样抄录，便于人工比对原图）
    expect(once).toContain('AI 提取原文：GLOOR\n4734P');
    const twice = buildStickerRemark({ remark: once, missing: ['sizeSpec'], rawText: 'GLOOR\n4734P' });
    expect(twice).toBe(once);
  });
});

describe('不干胶 · 视觉结果解析（不编造）', () => {
  it('去掉 markdown 代码围栏后解析 JSON', () => {
    const obj = extractJsonObject('```json\n{"brand":"GLOOR"}\n```');
    expect(obj).toEqual({ brand: 'GLOOR' });
  });

  it('模型先回参数回声再回 JSON（真实情况）→ 仍能正确取出 JSON 对象', () => {
    const noisy = '{"type": "json_object"}\n{"brand": "GLOOR", "sizeSpec": "25 - 50 MM", "qty": "", "rawText": "GLOOR\\nART. 4733P"}';
    const obj = extractJsonObject(noisy);
    expect(obj).toEqual({ brand: 'GLOOR', sizeSpec: '25 - 50 MM', qty: '', rawText: 'GLOOR\nART. 4733P' });
    const { extract, parsed } = parseStickerExtract(noisy);
    expect(parsed).toBe(true);
    expect(extract.brand).toBe('GLOOR');
    expect(extract.sizeSpec).toBe('25 - 50 MM');
    expect(extract.qty).toBeNull(); // 空字符串 = 没识别到，不猜
    expect(buildSuggestion(extract).title).toBe('GLOOR 25 - 50 MM');
  });

  it('字符串值里含花括号 / 转义引号也能正确配对', () => {
    const obj = extractJsonObject('{"brand": "A{B}C", "remark": "引号 \\" 与 } 花括号"}');
    expect(obj).toEqual({ brand: 'A{B}C', remark: '引号 " 与 } 花括号' });
  });

  it('非 JSON 文本 → parsed=false，rawText 保留原文，字段全空（绝不猜）', () => {
    const { extract, parsed } = parseStickerExtract('这张图看不清');
    expect(parsed).toBe(false);
    expect(extract.brand).toBe('');
    expect(extract.style).toBe('');
    expect(extract.sizeSpec).toBe('');
    expect(extract.rawText).toBe('这张图看不清');
  });

  it('数量只认纯数字，其余留空（不猜数量）', () => {
    expect(parseVisionQty('1000')).toBe(1000);
    expect(parseVisionQty('1,000')).toBe(1000);
    expect(parseVisionQty('一箱')).toBeNull();
    expect(parseVisionQty('约500')).toBeNull();
    expect(parseVisionQty('')).toBeNull();
    expect(parseVisionQty('12.7')).toBeNull();
  });

  it('识别结果 → 建议字段：标题按规则组合，缺项在 note 说明，单位默认张', () => {
    const { extract } = parseStickerExtract(JSON.stringify({
      brand: 'GLOOR', style: '', sizeSpec: '20×30mm', qty: '1000', unit: '',
      customer: '', remark: '', rawText: 'GLOOR 20×30',
    }));
    const s = buildSuggestion(extract);
    expect(s.title).toBe('GLOOR 20×30mm');
    expect(s.missing).toEqual(['style']);
    expect(s.unit).toBe('张');
    expect(s.qty).toBe(1000);
    expect(s.note).toContain('样式/系列');
  });
});
