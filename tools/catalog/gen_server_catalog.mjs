#!/usr/bin/env node
/**
 * 目录数据 → 服务端 TS 模块生成器（零依赖）
 * =============================================================================
 * 输入：tools/catalog/catalog_models.json（由 parse_catalog.mjs 从目录 HTML 解析而来）
 * 输出：apps/api/src/ai/catalog-models.ts（**生成文件，请勿手改**）
 *
 * 为什么要单独生成：服务端取价 / 识单匹配必须与目录**逐字符一致**（size 的前导零不能丢），
 * 所以两边共用同一份解析结果，禁止手抄。改目录 → 重跑 parse_catalog.mjs → 重跑本脚本。
 *
 * 用法：node tools/catalog/gen_server_catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const out = [];

out.push('/**');
out.push(' * 官方产品目录（切割嘴 CUTTING NOZZLES · 2026 版）机器可读型号矩阵 —— **本文件由脚本生成，请勿手改**。');
out.push(' *');
out.push(' * 生成器：tools/catalog/gen_server_catalog.mjs（数据来自 tools/catalog/catalog_models.json，');
out.push(' *         而该 JSON 由 tools/catalog/parse_catalog.mjs 直接解析甲方目录 HTML 得到）');
out.push(' * 来源：' + cat.source);
out.push(' * 规模：' + cat.seriesCount + ' 个系列 / ' + cat.modelCount + ' 个型号 / ' + cat.sizeCount + ' 条「型号 x size」');
out.push(' *');
out.push(' * 图例：size = 目录 size setting（**前导零有意义，0 / 00 / 000 是三档不同尺寸**）；');
out.push(' *       orifice = 切割孔径(mm)；thickness = 切割厚度范围(mm)；');
out.push(' *       gasType = LPG（丙烷）/ ACETYLENE（乙炔）。');
out.push(' *');
out.push(' * aliases 只登记「目录印刷型号之外、但确实指同一型号的写法」——目前只有目录里 A / M 两族的');
out.push(' * 气体后缀写法（A_AC / M_LPG 等），其余连字符/空格/点号差异由 product-model.ts 的 compactKey 天然覆盖。');
out.push(' */');
out.push('');
out.push('export interface CatalogSizeRow {');
out.push('  /** 目录 size setting（前导零原样保留） */');
out.push('  size: string;');
out.push('  /** 切割孔径(mm) */');
out.push('  orifice: string;');
out.push('  /** 切割厚度范围(mm) */');
out.push('  thickness: string;');
out.push('}');
out.push('');
out.push('export interface CatalogModel {');
out.push('  /** 目录印刷的型号（大写，含连字符） */');
out.push('  model: string;');
out.push('  /** 同一型号在单据上的其它写法（紧凑键去分隔符后比较） */');
out.push('  aliases?: string[];');
out.push('  /** 气体类型：LPG（丙烷）/ ACETYLENE（乙炔）/ null（目录未标注） */');
out.push("  gasType: 'LPG' | 'ACETYLENE' | null;");
out.push('  /** 目录表下的原样标注，如 GPN FOR L.P.G */');
out.push('  gasLabel: string;');
out.push('  /** 目录页码 */');
out.push('  page: number;');
out.push('  /** 该型号的全部 size 档位 */');
out.push('  sizes: CatalogSizeRow[];');
out.push('}');
out.push('');
out.push('export interface CatalogSeries {');
out.push('  /** 系列编号（目录里的 01 到 06） */');
out.push('  code: string;');
out.push('  /** 系列 / 款式名，如 AMERICAN STYLE CUTTING TIP */');
out.push('  series: string;');
out.push('  models: CatalogModel[];');
out.push('}');
out.push('');
out.push('/** 目录图例（与 catalog_parse_report.md 一致） */');
out.push('export const CATALOG_LEGEND = ' + JSON.stringify(cat.legend) + ' as const;');
out.push('');
out.push('/** 目录解析来源与规模（供报告 / 界面展示） */');
out.push('export const CATALOG_SOURCE = ' + JSON.stringify({
  source: cat.source, parsedAt: cat.parsedAt, seriesCount: cat.seriesCount,
  modelCount: cat.modelCount, sizeCount: cat.sizeCount,
}) + ' as const;');
out.push('');
out.push('/** ' + cat.seriesCount + ' 个系列 / ' + cat.modelCount + ' 个型号 / ' + cat.sizeCount + ' 条型号 x size（目录 2026 版） */');
out.push('export const CATALOG_SERIES: CatalogSeries[] = [');
for (const s of cat.series) {
  out.push('  {');
  out.push('    code: ' + JSON.stringify(s.code) + ',');
  out.push('    series: ' + JSON.stringify(s.series) + ',');
  out.push('    models: [');
  for (const m of s.models) {
    const alias = m.aliases ? ' aliases: ' + JSON.stringify(m.aliases) + ',' : '';
    const gas = m.gasType ? JSON.stringify(m.gasType) : 'null';
    out.push('      { model: ' + JSON.stringify(m.model) + ',' + alias + ' gasType: ' + gas
      + ', gasLabel: ' + JSON.stringify(m.gasLabel) + ', page: ' + m.page + ',');
    const sizes = m.sizes.map((r) => '{ size: ' + JSON.stringify(r.size) + ', orifice: ' + JSON.stringify(r.orifice)
      + ', thickness: ' + JSON.stringify(r.thickness) + ' }').join(', ');
    out.push('        sizes: [' + sizes + '] },');
  }
  out.push('    ],');
  out.push('  },');
}
out.push('];');
out.push('');
out.push('/** 全目录「型号」清单（用于报告里的覆盖率统计） */');
out.push('export const CATALOG_MODEL_NAMES: string[] = CATALOG_SERIES.flatMap((s) => s.models.map((m) => m.model));');
out.push('');

const target = path.join(REPO, 'apps', 'api', 'src', 'ai', 'catalog-models.ts');
fs.writeFileSync(target, out.join(String.fromCharCode(10)), 'utf8');
console.log('已生成 ' + target + '（' + cat.seriesCount + ' 系列 / ' + cat.modelCount + ' 型号 / ' + cat.sizeCount + ' 行）');