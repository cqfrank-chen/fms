/**
 * 目录（系列 + 气体类型）→ 系统产品类型（type）推导
 * =============================================================================
 * 甲方口径（本轮最高优先级）：**产品类型（type）与 gas_type 一律以官方目录为准**。
 *
 *   · gas_type：直接取目录的 `ACETYLENE`（目录写作 FOR ACE）/ `LPG`（目录写作 FOR L.P.G）；
 *   · type：由「目录款式（系列）+ 目录气体」推导。
 *
 * 为什么只有美式 / 英式能落到系统既有枚举：
 *   products.type 是 4 值业务枚举（英式/美式 × 乙炔/丙烷）+ 中立占位 tbd。
 *   官方目录按「款式」分 6 类（美式 / 日式 / 英式 / 法式 / 澳式 / 巴西式），
 *   其中只有 **AMERICAN → 美式（us）**、**BRITISH → 英式（uk）** 在既有枚举里有对应值。
 *   其余 4 个款式（JAPANESE / FRENCH / AUSTRALIAN / BRAZILIAN）在既有枚举里**没有对应值**，
 *   按「不臆造」原则一律保持 `tbd` 并标记，交甲方裁定（是否扩展枚举，见报告「待甲方确认」）。
 *
 * 与产品名里出现的「乙炔/丙烷」字样**无关** —— 目录才是权威（甲方规则）。
 */

/** 目录系列（款式）常量：与 catalog_models.json 的 series 字段逐字符一致 */
export const CATALOG_SERIES = [
  'AMERICAN STYLE CUTTING TIP',
  'JAPANESE STYLE CUTTING TIP',
  'BRITISH STYLE CUTTING TIP',
  'FRENCH STYLE CUTTING TIP',
  'AUSTRALIAN STYLE CUTTING TIP',
  'BRAZILIAN STYLE CUTTING TIP',
];

/** 系列 → 中文款式名（界面展示 / 报告用；系列排序按本数组的目录顺序） */
export const SERIES_LABEL = {
  'AMERICAN STYLE CUTTING TIP': '美式 AMERICAN',
  'JAPANESE STYLE CUTTING TIP': '日式 JAPANESE',
  'BRITISH STYLE CUTTING TIP': '英式 BRITISH',
  'FRENCH STYLE CUTTING TIP': '法式 FRENCH',
  'AUSTRALIAN STYLE CUTTING TIP': '澳式 AUSTRALIAN',
  'BRAZILIAN STYLE CUTTING TIP': '巴西式 BRAZILIAN',
};

/**
 * 能落到既有 4 值枚举的款式：AMERICAN → us（美式）、BRITISH → uk（英式）。
 * 其余款式**故意不在此表里** —— 映射不到 = 保持 tbd，绝不硬套成美式/英式。
 */
export const SERIES_TYPE_PREFIX = {
  'AMERICAN STYLE CUTTING TIP': 'us',
  'BRITISH STYLE CUTTING TIP': 'uk',
};

/** 目录气体类型（与 catalog_models.json 的 gasType 一致）→ 中文标签（界面展示用） */
export const GAS_TYPE_LABEL = {
  LPG: 'LPG（丙烷）',
  ACETYLENE: 'ACE（乙炔）',
};

/**
 * 目录（系列 + 气体）→ 系统产品类型。
 * 映射不到既有枚举（款式不是美式/英式，或缺气体类型）→ `tbd`（不臆造）。
 * @param {string|null|undefined} series 目录系列（如 'AMERICAN STYLE CUTTING TIP'）
 * @param {string|null|undefined} gasType 目录气体类型（'ACETYLENE' | 'LPG'）
 * @returns {'uk_acetylene'|'uk_propane'|'us_acetylene'|'us_propane'|'tbd'}
 */
export function deriveProductType(series, gasType) {
  const prefix = SERIES_TYPE_PREFIX[series];
  if (!prefix) return 'tbd';
  if (gasType === 'ACETYLENE') return prefix + '_acetylene';
  if (gasType === 'LPG') return prefix + '_propane';
  return 'tbd';
}

/** 该 (系列, 气体) 能否落到既有枚举（报告用：区分『目录已锚定但枚举承载不了』与『目录查不到』） */
export function typeDerivable(series, gasType) {
  return deriveProductType(series, gasType) !== 'tbd';
}
