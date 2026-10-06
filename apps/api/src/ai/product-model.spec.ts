import { CATALOG_SERIES } from './catalog-models';
import {
  catalogModelIndex, explainProductModel, findProductCandidates,
  parseProductModel, sameCatalogProduct,
} from './product-model';

/**
 * 「基础型号 + size」型号命中口径 —— 守门员测试（甲方规则 2026，最高优先级）
 * ---------------------------------------------------------------------------
 * 口径：型号名**前面或后面跟的数字、或 # 号后的数字** = 同一型号的不同 size。
 *   0-GPN / 00-GPN / 000-GPN = 型号 GPN 的三档不同尺寸 → 各自是独立产品，**绝不互相命中**。
 * 同时锚定必须依赖**官方目录**（6 系列 / 37 型号），目录外的写法一律不认（宁缺勿错）。
 */
describe('目录型号矩阵（catalog-models）', () => {
  it('6 个系列 / 37 个型号，系列名与目录一致', () => {
    expect(CATALOG_SERIES).toHaveLength(6);
    expect(CATALOG_SERIES.flatMap((s) => s.models)).toHaveLength(37);
    expect(CATALOG_SERIES.map((s) => s.code)).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(CATALOG_SERIES.map((s) => s.series)).toEqual([
      'AMERICAN STYLE CUTTING TIP', 'JAPANESE STYLE CUTTING TIP', 'BRITISH STYLE CUTTING TIP',
      'FRENCH STYLE CUTTING TIP', 'AUSTRALIAN STYLE CUTTING TIP', 'BRAZILIAN STYLE CUTTING TIP',
    ]);
  });

  it('逐系列型号数：美式 20 / 日式 9 / 英式 2 / 法式 2 / 澳式 2 / 巴西式 2', () => {
    expect(CATALOG_SERIES.map((s) => s.models.length)).toEqual([20, 9, 2, 2, 2, 2]);
  });

  it('每个型号都有尺寸档位，且 size 逐字符保留前导零（000 / 00 / 0 并存）', () => {
    for (const s of CATALOG_SERIES) {
      for (const m of s.models) expect(m.sizes.length).toBeGreaterThan(0);
    }
    const gpn = CATALOG_SERIES[0].models.find((m) => m.model === 'GPN')!;
    expect(gpn.gasType).toBe('LPG');
    expect(gpn.sizes.slice(0, 4).map((r) => r.size)).toEqual(['000', '00', '0', '1']);
    // 三档的孔径互不相同 —— 说明「前导零」确实是不同尺寸
    expect(gpn.sizes.slice(0, 3).map((r) => r.orifice)).toEqual(['0.7', '0.8', '1.0']);
  });

  it('型号索引：单字母的 A / M 两族必须带气体后缀才进索引（避免误认）', () => {
    const idx = catalogModelIndex();
    expect(idx.has('a')).toBe(false);
    expect(idx.has('m')).toBe(false);
    expect(idx.has('aace')).toBe(true); // A(ACE)
    expect(idx.has('mlpg')).toBe(true); // M(LPG)
  });
});

describe('parseProductModel：型号前 / 后 / # 后的数字 = size', () => {
  const p = (s: string) => parseProductModel(s);

  it('0-GPN / 00-GPN / 000-GPN：同一型号 GPN 的三档不同 size', () => {
    expect(p('0-GPN')).toMatchObject({ model: 'GPN', size: '0', gasType: 'LPG', sizeKnown: true });
    expect(p('00-GPN')).toMatchObject({ model: 'GPN', size: '00' });
    expect(p('000-GPN')).toMatchObject({ model: 'GPN', size: '000' });
  });

  it('106 #1 / 106 1#：两种写法都是「型号 106 + size 1」', () => {
    expect(p('106 #1')).toMatchObject({ model: '106', size: '1', gasType: 'LPG' });
    expect(p('106 1#')).toMatchObject({ model: '106', size: '1' });
  });

  it('1-1-101：前导数字是 size，基础型号是 1-101（美式乙炔）', () => {
    expect(p('1-1-101')).toMatchObject({
      model: '1-101', size: '1', series: 'AMERICAN STYLE CUTTING TIP', gasType: 'ACETYLENE', orificeMm: '1.2',
    });
    expect(p('2-1-101')).toMatchObject({ model: '1-101', size: '2' });
    expect(p('0-1-101')).toMatchObject({ model: '1-101', size: '0' });
    expect(p('00#-3-101')).toMatchObject({ model: '3-101', size: '00' });
    expect(p('割嘴 1#-3-101 产品号码6019')).toMatchObject({ model: '3-101', size: '1' });
  });

  it('「size」二字显式标注：1-101 size0 ≡ 0-1-101 ≡ 1-101 割嘴 0#（同一产品），且不跨 size', () => {
    // 甲方点名的第三种写法；与「型号前数字」「# 号数」三种写法必须归一到同一个 (型号, size)
    expect(p('1-101 size0')).toMatchObject({ model: '1-101', size: '0' });
    expect(p('1-101 size 0')).toMatchObject({ model: '1-101', size: '0' });
    expect(p('1-101 size #0')).toMatchObject({ model: '1-101', size: '0' });
    expect(p('GPN size 1')).toMatchObject({ model: 'GPN', size: '1' });
    // 前导零逐字符：size 00 ≠ size 0
    expect(p('1-101 size00')).toMatchObject({ model: '1-101', size: '00' });
    // 「size」后的数字不在该型号目录档位 → 尺寸未定死，整个候选作废（不当成「型号无尺寸」）
    expect(p('1-101 size 9')).toBeNull();
    expect(p('1-101 size 99')).toBeNull();
  });

  it('型号后跟 size：乙炔割嘴1-101-2 / 6290NX-2 / 106D7-2 / MC-12-2#', () => {
    expect(p('乙炔割嘴1-101-2 82g 货号：4191')).toMatchObject({ model: '1-101', size: '2' });
    expect(p('HARRIS 丙烷割嘴6290-NX-0 53g')).toMatchObject({ model: '6290NX', size: '0' });
    expect(p('6290NX-2')).toMatchObject({ model: '6290NX', size: '2' });
    expect(p('106D7-2')).toMatchObject({ model: '106D7', size: '2' });
    expect(p('割嘴 MC-12-2# 产品号码6004')).toMatchObject({ model: 'MC12', size: '2' });
  });

  it('品牌 / 描述前缀不影响解析（Victor 乙炔割嘴 1-1-101）', () => {
    expect(p('Victor 乙炔割嘴 1-1-101')).toMatchObject({ model: '1-101', size: '1' });
    expect(p('VICTOR 乙炔割嘴 1-1-101')).toMatchObject({ model: '1-101', size: '1' });
  });

  it('连字符 / 空格差异自动等价：3-GPN ↔ 3GPN、MC-12 ↔ MC12、6290-NX ↔ 6290NX', () => {
    expect(p('割嘴 1-3-GPN 产品号码6031')).toMatchObject({ model: '3GPN', size: '1' });
    expect(p('割嘴 2-3-GPN 产品号码6032')).toMatchObject({ model: '3GPN', size: '2' });
    expect(p('SC50-1')).toMatchObject({ model: 'SC50', size: '1' });
    expect(p('sm 丙烷割嘴 SC-50-A-0 93g')).toMatchObject({ model: 'SC50', size: '0' });
  });

  it('法式 / 巴西式 / 日式特殊型号', () => {
    expect(p('G1-A')).toMatchObject({ model: 'G1-A', gasType: 'ACETYLENE', size: null, sizeKnown: false });
    expect(p('G1-P')).toMatchObject({ model: 'G1-P', gasType: 'LPG' });
    expect(p('G1-P16/10')).toMatchObject({ model: 'G1-P', size: '16/10' });
    expect(p('1502')).toMatchObject({ model: '1502', gasType: 'ACETYLENE' });
    expect(p('1502 割嘴 2#')).toMatchObject({ model: '1502', size: '2' });
    expect(p('1503丙烷割嘴 #4 包装：塑料盒贴型号')).toMatchObject({ model: '1503', size: '4' });
    expect(p('M(ACE) 1#')).toMatchObject({ model: 'M(ACE)', gasType: 'ACETYLENE', size: '1' });
    expect(p('A(LPG) 2#')).toMatchObject({ model: 'A(LPG)', gasType: 'LPG', size: '2' });
  });

  it('目录档位之外 / 数字歧义 / 货号误认 —— 一律不锚定（宁缺勿错）', () => {
    expect(p('0000-GPN')).toBeNull(); // 不是目录档位，且不得退化成「GPN 无尺寸」
    expect(p('1380')).toBeNull(); // 不得被认成 138 的 size 0
    expect(p('4154')).toBeNull(); // 不得被认成型号 41
    expect(p('货号：4154')).toBeNull();
    expect(p('割嘴 1-GPN 2#')).toBeNull(); // 型号前后数字不同 → 尺寸歧义
    expect(p('PNME18 割嘴 1/16')).toBeNull(); // 18 不是 PNME 档位，尺寸未定死
    expect(p('106HC-2')).toBeNull(); // 106HC 不在目录
    expect(p('PNM 1/32')).toBeNull(); // PNM 不在目录（目录是 PNME）
    expect(p('')).toBeNull();
  });

  it('只写了型号、没写尺寸 → size = null（**不等于任意尺寸**）', () => {
    expect(p('1-101')).toMatchObject({ model: '1-101', size: null, sizeKnown: false });
    expect(p('GPN')).toMatchObject({ model: 'GPN', size: null });
  });

  it('explainProductModel 给出未锚定原因（报告 / 排障用）', () => {
    expect(explainProductModel('106HC-2').reason).toContain('型号边界不干净');
    expect(explainProductModel('完全无关的名称').reason).toBe('型号未锚定到目录');
    expect(explainProductModel('割嘴 1-GPN 2#').reason).toContain('尺寸有歧义');
    expect(explainProductModel('PNME18 割嘴 1/16').reason).toContain('尺寸不在目录档位');
    expect(explainProductModel('1-1-101').reason).toBeNull();
  });
});

describe('sameCatalogProduct：基础型号 + size 相同才算命中', () => {
  it('品牌前缀差异可忽略（计划单 1-1-101 ↔ 合同 Victor 乙炔割嘴 1-1-101）', () => {
    expect(sameCatalogProduct('1-1-101', 'Victor 乙炔割嘴 1-1-101')).toBe(true);
    expect(sameCatalogProduct('2-1-101', '乙炔割嘴1-101-2 82g 货号：4191')).toBe(true);
    expect(sameCatalogProduct('1-GPN', 'victor 丙烷割嘴 GPN-1')).toBe(true);
    expect(sameCatalogProduct('106 #1', '106 1#')).toBe(true);
  });

  it('跨 size 一律不命中（含前导零 / 型号前数字 / # 号数差异）', () => {
    expect(sameCatalogProduct('0-GPN', '00-GPN')).toBe(false);
    expect(sameCatalogProduct('00-GPN', '000-GPN')).toBe(false);
    expect(sameCatalogProduct('0-GPN', 'victor 丙烷割嘴 GPN－00#')).toBe(false);
    expect(sameCatalogProduct('1-1-101', '2-1-101')).toBe(false);
    expect(sameCatalogProduct('1-1-101', '割嘴 1-101 0#')).toBe(false);
    expect(sameCatalogProduct('106 #1', '106 2#')).toBe(false);
  });

  it('一边没写尺寸 → 不命中（宁缺勿错）', () => {
    expect(sameCatalogProduct('1-101', '1-1-101')).toBe(false);
    expect(sameCatalogProduct('1-101', '割嘴 1-101 00#')).toBe(false);
  });

  it('锚定不到目录的一律不命中（不做子串凑覆盖率）', () => {
    expect(sameCatalogProduct('106HC-2', '106HC 2#')).toBe(false);
    expect(sameCatalogProduct('2-W', '2-W')).toBe(false);
    expect(sameCatalogProduct('', '1-1-101')).toBe(false);
  });
});

describe('findProductCandidates：档案候选的唯一权威选法', () => {
  const archive = [
    { id: 1, name: '1-1-101' },
    { id: 2, name: '2-1-101' },
    { id: 3, name: '1-101 割嘴 00#' },
    { id: 4, name: 'GPN-1' },
    { id: 5, name: '106HC-2' },
  ];
  const sameDigits = (a: string, b: string) =>
    (String(a).match(/[0-9]+/g) ?? []).join('-') === (String(b).match(/[0-9]+/g) ?? []).join('-');

  it('① 名称完全相同优先', () => {
    expect(findProductCandidates('1-1-101', archive, { sameDigits })).toMatchObject({ kind: 'exact', hits: [{ id: 1 }] });
  });

  it('② 基础型号 + size 相同（描述前缀不同也能对上，但绝不跨 size）', () => {
    const r = findProductCandidates('Victor 乙炔割嘴 1-1-101', archive, { sameDigits });
    expect(r.kind).toBe('catalog');
    expect(r.hits.map((h) => h.id)).toEqual([1]);
    // 00# 那条是「1-101 的另一个尺寸」，不是 1-1-101 → 不命中
    expect(r.hits.some((h) => h.id === 3)).toBe(false);
  });

  it('多候选不自动选（返回全部，由调用方要求人工确认）', () => {
    const two = [{ id: 7, name: 'GPN-1' }, { id: 8, name: '丙烷割嘴 GPN-1' }];
    const r = findProductCandidates('1-GPN', two, { sameDigits });
    expect(r.kind).toBe('catalog');
    expect(r.hits.map((h) => h.id).sort()).toEqual([7, 8]);
  });

  it('②\' 同一型号同一尺寸的多种写法：整名数字指纹再收窄（不把唯一命中弄丢）', () => {
    // ANME 3/64 与「乙炔割嘴 ANME 3/64 92g」同为 (ANME, 3/64)，但后者多了重量 92g → 指纹 3-64-92 不同；
    // 计划单的「ANME3/64」应收窄到指纹一致的那一条，而不是被判成「多候选」弄丢归档。
    const arch = [
      { id: 1, name: 'ANME 3/64' },
      { id: 2, name: '乙炔割嘴 ANME 3/64 92g' },
      { id: 3, name: '乙炔割嘴ANME 3/64  重量：85g' },
    ];
    const r = findProductCandidates('ANME3/64', arch, { sameDigits });
    expect(r.kind).toBe('catalog');
    expect(r.hits.map((h) => h.id)).toEqual([1]);
  });

  it('③ 子串容错（带数字守卫）仍然生效；关掉 substring 就不容错', () => {
    // 「106HC-2」（档案名）与「106HC 2#」（单据写法）→ 归一相同 + 数字指纹相同 → 子串档命中
    const on = findProductCandidates('106HC 2#', archive, { sameDigits });
    expect(on).toMatchObject({ kind: 'substring', hits: [{ id: 5 }] });
    const off = findProductCandidates('106HC 2#', archive, { substring: false, sameDigits });
    expect(off.kind).toBe('none');
  });

  it('数字指纹不同 → 子串容错也不许跨尺寸命中', () => {
    // 计划单「1-101」不得落到档案「1-101 割嘴 00#」（数字指纹 101 vs 101-00）
    const r = findProductCandidates('1-101', archive, { sameDigits });
    expect(r.hits.map((h) => h.id)).not.toContain(3);
  });

  it('空名字 → 无候选', () => {
    expect(findProductCandidates('', archive, { sameDigits })).toMatchObject({ kind: 'none', hits: [] });
  });
});
