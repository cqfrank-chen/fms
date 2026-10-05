import {
  digitSignature, normalizeToken, productIdentityKey, sameProductDigits, sameProductModel,
} from './table-parser.service';

/**
 * 型号归一口径单元测试（2026 甲方更正，最高优先级）
 * =============================================================================
 * 甲方更正原文：「**0-GPN 和 00-GPN 是同一型号的不同尺寸**」→
 *   ① 前导零 / 数字位数差异 = 不同尺寸 = 不同产品，**绝不合并**；
 *   ② 归一化只做「空格 / 全角半角 / 大小写 / 标点」层面，**数字部分原样保留、逐字符比较**；
 *   ③ 绝不在归一化时删除前导零或折叠数字位。
 * 本文件是这条口径的**回归护栏**：任何人再往归一化里加「数字折叠」都会在这里红掉。
 */
describe('归一化只碰文本外壳，绝不碰数字', () => {
  it('normalizeToken 不删前导零、不折叠数字位', () => {
    expect(normalizeToken('0-GPN')).toBe('0gpn');
    expect(normalizeToken('00-GPN')).toBe('00gpn');
    expect(normalizeToken('000-GPN')).toBe('000gpn');
    expect(normalizeToken('1-1-101')).toBe('11101');
    expect(normalizeToken('111-01')).toBe('11101'); // 标点被删 → 文本层面假相等（数字指纹会拦住）
  });

  it('0-GPN / 00-GPN / 000-GPN 归一后**互不相等**（前导零 = 不同尺寸）', () => {
    const a = normalizeToken('0-GPN');
    const b = normalizeToken('00-GPN');
    const c = normalizeToken('000-GPN');
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('数字位数不同也互不相等（GPN-1 ≠ GPN-10 ≠ GPN-100）', () => {
    const ks = ['GPN-1', 'GPN-10', 'GPN-100'].map(normalizeToken);
    expect(new Set(ks).size).toBe(3);
  });

  it('纯文本差异仍然正确归一：全角 / 空格 / 大小写 / 标点', () => {
    const base = normalizeToken('1-101 割嘴 00#');
    expect(normalizeToken('１－１０１　割嘴　００＃')).toBe(base); // 全角 + 全角空格
    expect(normalizeToken('1-101割嘴00#')).toBe(base);          // 去空格
    expect(normalizeToken(' 1-101 割嘴 00# ')).toBe(base);        // 前后空格
    expect(normalizeToken('1.101 割嘴 00#')).toBe(base);         // 标点差异（. ↔ -）
  });
});

describe('digitSignature：数字部分逐字符指纹', () => {
  it('前导零与位数原样保留', () => {
    expect(digitSignature('0-GPN')).toBe('0');
    expect(digitSignature('00-GPN')).toBe('00');
    expect(digitSignature('000-GPN')).toBe('000');
    expect(digitSignature('GPN-1')).toBe('1');
    expect(digitSignature('GPN-10')).toBe('10');
    expect(digitSignature('1-1-101')).toBe('1-1-101');
    expect(digitSignature('111-01')).toBe('111-01');
    expect(digitSignature('1 1 101')).toBe('1-1-101'); // 分隔标点差异不影响数字指纹
  });

  it('没有数字 → 空指纹（不与任何带数字的写法相等）', () => {
    expect(digitSignature('割嘴')).toBe('');
    expect(digitSignature('')).toBe('');
  });
});

describe('sameProductModel / productIdentityKey：同一型号的唯一判定', () => {
  it('前导零 / 数字位差异 → **不是**同一型号', () => {
    expect(sameProductModel('0-GPN', '00-GPN')).toBe(false);
    expect(sameProductModel('00-GPN', '000-GPN')).toBe(false);
    expect(sameProductModel('0-1-101', '00-1-101')).toBe(false);
    expect(sameProductModel('GPN-1', 'GPN-10')).toBe(false);
  });

  it('标点删除导致的「文本假相等」被数字指纹拦住（1-1-101 vs 111-01）', () => {
    // 文本归一相同……
    expect(normalizeToken('1-1-101')).toBe(normalizeToken('111-01'));
    // ……但数字指纹不同 → 不是同一型号（否则会串尺寸、串价格）
    expect(sameProductModel('1-1-101', '111-01')).toBe(false);
  });

  it('纯文本差异（全角/空格/大小写/标点）仍然判定为同一型号', () => {
    expect(sameProductModel('1-101 割嘴 00#', '１－１０１　割嘴　００＃')).toBe(true);
    expect(sameProductModel('1-101 割嘴 00#', '1-101割嘴00#')).toBe(true);
    expect(sameProductModel('Victor 乙炔割嘴 1-1-101', 'VICTOR 乙炔割嘴 1-1-101')).toBe(true);
  });

  it('productIdentityKey：0-GPN / 00-GPN / 000-GPN 是三个不同的键（去重不会合并尺寸）', () => {
    const ks = ['0-GPN', '00-GPN', '000-GPN'].map(productIdentityKey);
    expect(new Set(ks).size).toBe(3);
    expect(productIdentityKey('0-GPN')).toBe('0gpn#0');
    expect(productIdentityKey('00-GPN')).toBe('00gpn#00');
  });

  it('productIdentityKey：纯文本差异折叠成同一个键（可以合并）', () => {
    expect(productIdentityKey('1-101 割嘴 00#')).toBe(productIdentityKey('１－１０１　割嘴　００＃'));
  });
});

describe('sameProductDigits：子串容错匹配的前置守卫', () => {
  it('只比数字部分：0-GPN 与 00-GPN 的数字指纹不同 → 守卫拒绝', () => {
    expect(sameProductDigits('1-101', '1-101 割嘴 00#')).toBe(false); // 计划单 1-101 绝不能落到 00# 那条档案
    expect(sameProductDigits('0-GPN', '00-GPN')).toBe(false);
    expect(sameProductDigits('0-GPN', 'victor 丙烷割嘴 GPN－00#')).toBe(false);
  });

  it('数字部分一致时放行（描述/品牌前缀差异允许命中）', () => {
    expect(sameProductDigits('1-1-101', 'Victor 乙炔割嘴 1-1-101')).toBe(true);
    expect(sameProductDigits('1-101 割嘴 00#', '割嘴 #1-101 00#')).toBe(true);
  });
});
