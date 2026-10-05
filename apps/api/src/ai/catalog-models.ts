/**
 * 官方产品目录（切割嘴 CUTTING NOZZLES · 2026 版）机器可读型号矩阵 —— **本文件由脚本生成，请勿手改**。
 *
 * 生成器：tools/catalog/gen_server_catalog.mjs（数据来自 tools/catalog/catalog_models.json，
 *         而该 JSON 由 tools/catalog/parse_catalog.mjs 直接解析甲方目录 HTML 得到）
 * 来源：D:/Dsh/project/product_catalog/Product_Model_Catalogue_photos_only.html
 * 规模：6 个系列 / 37 个型号 / 286 条「型号 x size」
 *
 * 图例：size = 目录 size setting（**前导零有意义，0 / 00 / 000 是三档不同尺寸**）；
 *       orifice = 切割孔径(mm)；thickness = 切割厚度范围(mm)；
 *       gasType = LPG（丙烷）/ ACETYLENE（乙炔）。
 *
 * aliases 只登记「目录印刷型号之外、但确实指同一型号的写法」——目前只有目录里 A / M 两族的
 * 气体后缀写法（A_AC / M_LPG 等），其余连字符/空格/点号差异由 product-model.ts 的 compactKey 天然覆盖。
 */

export interface CatalogSizeRow {
  /** 目录 size setting（前导零原样保留） */
  size: string;
  /** 切割孔径(mm) */
  orifice: string;
  /** 切割厚度范围(mm) */
  thickness: string;
}

export interface CatalogModel {
  /** 目录印刷的型号（大写，含连字符） */
  model: string;
  /** 同一型号在单据上的其它写法（紧凑键去分隔符后比较） */
  aliases?: string[];
  /** 气体类型：LPG（丙烷）/ ACETYLENE（乙炔）/ null（目录未标注） */
  gasType: 'LPG' | 'ACETYLENE' | null;
  /** 目录表下的原样标注，如 GPN FOR L.P.G */
  gasLabel: string;
  /** 目录页码 */
  page: number;
  /** 该型号的全部 size 档位 */
  sizes: CatalogSizeRow[];
}

export interface CatalogSeries {
  /** 系列编号（目录里的 01 到 06） */
  code: string;
  /** 系列 / 款式名，如 AMERICAN STYLE CUTTING TIP */
  series: string;
  models: CatalogModel[];
}

/** 目录图例（与 catalog_parse_report.md 一致） */
export const CATALOG_LEGEND = {"size":"catalogue size setting","orifice":"cutting orifice (mm)","thickness":"cutting thickness range (mm)"} as const;

/** 目录解析来源与规模（供报告 / 界面展示） */
export const CATALOG_SOURCE = {"source":"D:/Dsh/project/product_catalog/Product_Model_Catalogue_photos_only.html","parsedAt":"2026-10-05","seriesCount":6,"modelCount":37,"sizeCount":286} as const;

/** 6 个系列 / 37 个型号 / 286 条型号 x size（目录 2026 版） */
export const CATALOG_SERIES: CatalogSeries[] = [
  {
    code: "01",
    series: "AMERICAN STYLE CUTTING TIP",
    models: [
      { model: "1-101", gasType: "ACETYLENE", gasLabel: "1-101 FOR ACE", page: 2,
        sizes: [{ size: "000", orifice: "0.7", thickness: "1-3" }, { size: "00", orifice: "0.8", thickness: "3-6" }, { size: "0", orifice: "1.0", thickness: "6-10" }, { size: "1", orifice: "1.2", thickness: "10-20" }, { size: "2", orifice: "1.5", thickness: "20-40" }, { size: "3", orifice: "1.8", thickness: "40-60" }, { size: "4", orifice: "2.1", thickness: "60-80" }, { size: "5", orifice: "2.5", thickness: "80-125" }, { size: "6", orifice: "3.1", thickness: "125-200" }, { size: "7", orifice: "3.6", thickness: "200-250" }, { size: "8", orifice: "4.1", thickness: "250-300" }] },
      { model: "1-118", gasType: "ACETYLENE", gasLabel: "1-118 FOR ACE", page: 2,
        sizes: [{ size: "0", orifice: "1.2", thickness: "1.8x5" }, { size: "2", orifice: "1.5", thickness: "2.4x5" }, { size: "4", orifice: "1.8", thickness: "2.5x5" }, { size: "6", orifice: "2.1", thickness: "2.8x10" }, { size: "8", orifice: "2.4", thickness: "3.2x10" }] },
      { model: "3-101", gasType: "ACETYLENE", gasLabel: "3-101 FOR ACE", page: 2,
        sizes: [{ size: "000", orifice: "0.7", thickness: "1-3" }, { size: "00", orifice: "0.8", thickness: "3-6" }, { size: "0", orifice: "1.0", thickness: "6-10" }, { size: "1", orifice: "1.2", thickness: "10-20" }, { size: "2", orifice: "1.5", thickness: "20-40" }, { size: "3", orifice: "1.8", thickness: "40-60" }, { size: "4", orifice: "2.1", thickness: "60-80" }, { size: "5", orifice: "2.5", thickness: "80-125" }] },
      { model: "3GPN", gasType: "LPG", gasLabel: "3GPN FOR L.P.G", page: 3,
        sizes: [{ size: "00", orifice: "0.8", thickness: "3-6" }, { size: "0", orifice: "1.0", thickness: "6-10" }, { size: "1", orifice: "1.2", thickness: "10-20" }, { size: "2", orifice: "1.5", thickness: "20-40" }, { size: "3", orifice: "1.8", thickness: "40-60" }, { size: "4", orifice: "2.1", thickness: "60-80" }, { size: "5", orifice: "2.5", thickness: "80-125" }] },
      { model: "138", gasType: "ACETYLENE", gasLabel: "138 FOR ACE", page: 3,
        sizes: [{ size: "00", orifice: "0.8", thickness: "1-3" }, { size: "0", orifice: "1.0", thickness: "3-6" }, { size: "1", orifice: "1.2", thickness: "6-10" }, { size: "2", orifice: "1.4", thickness: "10-20" }, { size: "3", orifice: "1.6", thickness: "20-40" }, { size: "4", orifice: "1.8", thickness: "40-60" }, { size: "5", orifice: "2.1", thickness: "60-100" }, { size: "6", orifice: "2.4", thickness: "100-150" }] },
      { model: "144", gasType: "ACETYLENE", gasLabel: "144 FOR ACE", page: 3,
        sizes: [{ size: "00", orifice: "0.8", thickness: "3-6" }, { size: "0", orifice: "1.0", thickness: "6-10" }, { size: "1", orifice: "1.2", thickness: "10-20" }, { size: "2", orifice: "1.4", thickness: "20-40" }, { size: "3", orifice: "1.6", thickness: "40-60" }, { size: "4", orifice: "1.8", thickness: "60-100" }, { size: "5", orifice: "2.0", thickness: "100-150" }, { size: "6", orifice: "2.4", thickness: "150-200" }, { size: "7", orifice: "2.8", thickness: "200-250" }, { size: "8", orifice: "3.2", thickness: "250-300" }] },
      { model: "164", gasType: "ACETYLENE", gasLabel: "164 FOR ACE", page: 4,
        sizes: [{ size: "00", orifice: "0.8", thickness: "3-6" }, { size: "0", orifice: "1.0", thickness: "6-10" }, { size: "1", orifice: "1.2", thickness: "10-20" }, { size: "2", orifice: "1.4", thickness: "20-40" }, { size: "3", orifice: "1.6", thickness: "40-60" }, { size: "4", orifice: "1.8", thickness: "60-100" }, { size: "5", orifice: "2.0", thickness: "100-150" }, { size: "6", orifice: "2.4", thickness: "150-200" }, { size: "7", orifice: "2.8", thickness: "200-250" }, { size: "8", orifice: "3.2", thickness: "250-300" }] },
      { model: "229", gasType: "LPG", gasLabel: "229 FOR L.P.G", page: 4,
        sizes: [{ size: "00", orifice: "0.6", thickness: "1-3" }, { size: "0", orifice: "0.8", thickness: "3-6" }, { size: "1", orifice: "1.0", thickness: "6-10" }, { size: "2", orifice: "1.2", thickness: "10-15" }, { size: "3", orifice: "1.4", thickness: "15-25" }, { size: "4", orifice: "1.6", thickness: "25-50" }, { size: "5", orifice: "1.9", thickness: "50-100" }, { size: "6", orifice: "2.5", thickness: "100-150" }, { size: "7", orifice: "2.8", thickness: "150-200" }, { size: "8", orifice: "3.2", thickness: "200-250" }] },
      { model: "261", gasType: "LPG", gasLabel: "261 FOR L.P.G", page: 4,
        sizes: [{ size: "00", orifice: "0.6", thickness: "1-3" }, { size: "0", orifice: "0.8", thickness: "3-6" }, { size: "1", orifice: "1.0", thickness: "6-10" }, { size: "2", orifice: "1.2", thickness: "10-15" }, { size: "3", orifice: "1.4", thickness: "15-25" }, { size: "4", orifice: "1.6", thickness: "25-50" }, { size: "5", orifice: "1.9", thickness: "50-100" }, { size: "6", orifice: "2.5", thickness: "100-150" }, { size: "7", orifice: "2.8", thickness: "150-200" }, { size: "8", orifice: "3.2", thickness: "200-250" }] },
      { model: "275", gasType: "LPG", gasLabel: "275 FOR L.P.G", page: 5,
        sizes: [{ size: "00", orifice: "0.6", thickness: "1-3" }, { size: "0", orifice: "0.8", thickness: "3-6" }, { size: "1", orifice: "1.0", thickness: "6-10" }, { size: "2", orifice: "1.2", thickness: "10-15" }, { size: "3", orifice: "1.4", thickness: "15-25" }, { size: "4", orifice: "1.6", thickness: "25-50" }, { size: "5", orifice: "1.9", thickness: "50-100" }, { size: "6", orifice: "2.5", thickness: "100-150" }, { size: "7", orifice: "2.8", thickness: "150-200" }, { size: "8", orifice: "3.2", thickness: "200-250" }] },
      { model: "6290", gasType: "ACETYLENE", gasLabel: "6290 FOR ACE", page: 5,
        sizes: [{ size: "000", orifice: "0.8", thickness: "1-5" }, { size: "00", orifice: "0.9", thickness: "5-10" }, { size: "0", orifice: "1.0", thickness: "10-15" }, { size: "1", orifice: "1.2", thickness: "15-25" }, { size: "2", orifice: "1.6", thickness: "25-50" }, { size: "3", orifice: "2.0", thickness: "50-100" }, { size: "4", orifice: "2.4", thickness: "100-175" }, { size: "5", orifice: "2.8", thickness: "175-250" }, { size: "6", orifice: "3.2", thickness: "250-300" }] },
      { model: "6290AC", gasType: "ACETYLENE", gasLabel: "6290AC FOR ACE", page: 5,
        sizes: [{ size: "000", orifice: "0.8", thickness: "1-5" }, { size: "00", orifice: "0.9", thickness: "5-10" }, { size: "0", orifice: "1.0", thickness: "10-15" }, { size: "1", orifice: "1.2", thickness: "15-25" }, { size: "2", orifice: "1.6", thickness: "25-50" }, { size: "3", orifice: "2.0", thickness: "50-100" }, { size: "4", orifice: "2.4", thickness: "100-175" }, { size: "5", orifice: "2.8", thickness: "175-250" }, { size: "6", orifice: "3.2", thickness: "250-300" }] },
      { model: "6290NFF", gasType: "LPG", gasLabel: "6290NFF FOR L.P.G", page: 6,
        sizes: [{ size: "0", orifice: "1.0", thickness: "10-15" }, { size: "1", orifice: "1.2", thickness: "15-25" }, { size: "2", orifice: "1.6", thickness: "25-50" }, { size: "3", orifice: "2.0", thickness: "50-100" }, { size: "4", orifice: "2.4", thickness: "100-175" }, { size: "5", orifice: "2.8", thickness: "175-250" }, { size: "6", orifice: "3.2", thickness: "250-300" }] },
      { model: "6290NX", gasType: "LPG", gasLabel: "6290NX FOR L.P.G", page: 6,
        sizes: [{ size: "000", orifice: "0.8", thickness: "1-5" }, { size: "00", orifice: "0.9", thickness: "5-10" }, { size: "0", orifice: "1.0", thickness: "10-15" }, { size: "1", orifice: "1.2", thickness: "15-25" }, { size: "2", orifice: "1.6", thickness: "25-50" }, { size: "3", orifice: "2.0", thickness: "50-100" }, { size: "4", orifice: "2.4", thickness: "100-175" }, { size: "5", orifice: "2.8", thickness: "175-250" }, { size: "6", orifice: "3.2", thickness: "250-300" }] },
      { model: "GPN", gasType: "LPG", gasLabel: "GPN FOR L.P.G", page: 6,
        sizes: [{ size: "000", orifice: "0.7", thickness: "1-3" }, { size: "00", orifice: "0.8", thickness: "3-6" }, { size: "0", orifice: "1.0", thickness: "6-10" }, { size: "1", orifice: "1.2", thickness: "10-20" }, { size: "2", orifice: "1.5", thickness: "20-40" }, { size: "3", orifice: "1.8", thickness: "40-60" }, { size: "4", orifice: "2.1", thickness: "60-80" }, { size: "5", orifice: "2.5", thickness: "80-125" }, { size: "6", orifice: "3.1", thickness: "125-200" }, { size: "7", orifice: "3.6", thickness: "200-250" }, { size: "8", orifice: "4.1", thickness: "250-300" }] },
      { model: "HPN", gasType: "LPG", gasLabel: "HPN FOR L.P.G", page: 7,
        sizes: [{ size: "1", orifice: "1.0", thickness: "10-20" }, { size: "2", orifice: "1.2", thickness: "20-40" }, { size: "3", orifice: "1.4", thickness: "40-60" }, { size: "4", orifice: "1.8", thickness: "60-80" }, { size: "5", orifice: "2.0", thickness: "80-125" }, { size: "6", orifice: "2.4", thickness: "125-200" }, { size: "7", orifice: "2.8", thickness: "200-250" }, { size: "8", orifice: "3.2", thickness: "250-300" }, { size: "10", orifice: "4.0", thickness: "300-380" }, { size: "12", orifice: "4.5", thickness: "380-450" }] },
      { model: "MC12", gasType: "ACETYLENE", gasLabel: "MC12 FOR ACE", page: 7,
        sizes: [{ size: "00", orifice: "0.8", thickness: "3-5" }, { size: "0", orifice: "1.0", thickness: "5-10" }, { size: "1", orifice: "1.2", thickness: "10-15" }, { size: "2", orifice: "1.4", thickness: "15-30" }, { size: "3", orifice: "1.7", thickness: "30-50" }, { size: "4", orifice: "2.1", thickness: "50-100" }, { size: "5", orifice: "2.4", thickness: "100-150" }] },
      { model: "MC40", gasType: "LPG", gasLabel: "MC40 FOR L.P.G", page: 7,
        sizes: [{ size: "00", orifice: "0.8", thickness: "3-5" }, { size: "0", orifice: "1.0", thickness: "5-10" }, { size: "1", orifice: "1.2", thickness: "10-15" }, { size: "2", orifice: "1.4", thickness: "15-30" }, { size: "3", orifice: "1.6", thickness: "30-50" }, { size: "4", orifice: "1.8", thickness: "50-100" }] },
      { model: "SC12", gasType: "ACETYLENE", gasLabel: "SC12 FOR ACE", page: 8,
        sizes: [{ size: "000", orifice: "0.7", thickness: "1-3" }, { size: "00", orifice: "0.8", thickness: "3-5" }, { size: "0", orifice: "1.0", thickness: "5-10" }, { size: "1", orifice: "1.2", thickness: "10-15" }, { size: "2", orifice: "1.4", thickness: "15-30" }, { size: "3", orifice: "1.7", thickness: "30-50" }, { size: "4", orifice: "2.0", thickness: "50-100" }, { size: "5", orifice: "2.3", thickness: "100-200" }, { size: "6", orifice: "2.6", thickness: "200-300" }, { size: "7", orifice: "3.0", thickness: "300-350" }] },
      { model: "SC50", gasType: "LPG", gasLabel: "SC50 FOR L.P.G", page: 8,
        sizes: [{ size: "00", orifice: "0.8", thickness: "3-5" }, { size: "0", orifice: "1.0", thickness: "5-10" }, { size: "1", orifice: "1.2", thickness: "10-15" }, { size: "2", orifice: "1.5", thickness: "15-30" }, { size: "3", orifice: "1.8", thickness: "30-50" }, { size: "4", orifice: "2.1", thickness: "50-100" }, { size: "5", orifice: "2.4", thickness: "100-200" }, { size: "6", orifice: "2.8", thickness: "200-300" }, { size: "7", orifice: "3.2", thickness: "300-350" }, { size: "8", orifice: "3.6", thickness: "350-450" }, { size: "9", orifice: "4.4", thickness: "450-500" }] },
    ],
  },
  {
    code: "02",
    series: "JAPANESE STYLE CUTTING TIP",
    models: [
      { model: "102", gasType: "ACETYLENE", gasLabel: "102 FOR ACE", page: 9,
        sizes: [{ size: "00", orifice: "0.8", thickness: "0-5" }, { size: "0", orifice: "1.0", thickness: "5-10" }, { size: "1", orifice: "1.2", thickness: "10-15" }, { size: "2", orifice: "1.4", thickness: "15-30" }, { size: "3", orifice: "1.6", thickness: "30-40" }, { size: "4", orifice: "1.8", thickness: "40-50" }, { size: "5", orifice: "2.0", thickness: "50-100" }, { size: "6", orifice: "2.4", thickness: "100-150" }, { size: "7", orifice: "2.8", thickness: "150-200" }, { size: "8", orifice: "3.2", thickness: "250-300" }] },
      { model: "106", gasType: "LPG", gasLabel: "106 FOR L.P.G", page: 9,
        sizes: [{ size: "00", orifice: "0.8", thickness: "0-5" }, { size: "0", orifice: "1.0", thickness: "5-10" }, { size: "1", orifice: "1.2", thickness: "10-15" }, { size: "2", orifice: "1.4", thickness: "15-30" }, { size: "3", orifice: "1.6", thickness: "30-40" }, { size: "4", orifice: "1.8", thickness: "40-50" }, { size: "5", orifice: "2.0", thickness: "50-100" }, { size: "6", orifice: "2.4", thickness: "100-150" }, { size: "7", orifice: "2.8", thickness: "150-200" }, { size: "8", orifice: "3.2", thickness: "250-300" }] },
      { model: "106D7", gasType: "LPG", gasLabel: "106D7 FOR L.P.G", page: 9,
        sizes: [{ size: "00", orifice: "0.6", thickness: "5-10" }, { size: "0", orifice: "0.8", thickness: "10-20" }, { size: "1", orifice: "1.0", thickness: "20-40" }, { size: "2", orifice: "1.25", thickness: "40-60" }, { size: "3", orifice: "1.5", thickness: "60-100" }, { size: "4", orifice: "1.75", thickness: "100-150" }, { size: "5", orifice: "2.0", thickness: "150-180" }, { size: "6", orifice: "2.3", thickness: "180-220" }] },
      { model: "A(ACE)", aliases: ["A_AC","A-AC"], gasType: "ACETYLENE", gasLabel: "A(ACE) FOR ACE", page: 10,
        sizes: [{ size: "1", orifice: "1.0", thickness: "1-15" }, { size: "2", orifice: "1.3", thickness: "15-50" }, { size: "3", orifice: "1.6", thickness: "50-100" }] },
      { model: "A(LPG)", aliases: ["A_LPG","A-LPG"], gasType: "LPG", gasLabel: "A(LPG) FOR L.P.G", page: 10,
        sizes: [{ size: "1", orifice: "1.0", thickness: "1-15" }, { size: "2", orifice: "1.3", thickness: "15-50" }, { size: "3", orifice: "1.6", thickness: "50-100" }] },
      { model: "M(ACE)", aliases: ["M_AC","M-AC"], gasType: "ACETYLENE", gasLabel: "M(ACE) FOR ACE", page: 10,
        sizes: [{ size: "1", orifice: "0.7", thickness: "1-5" }, { size: "2", orifice: "0.9", thickness: "5-15" }, { size: "3", orifice: "1.1", thickness: "15-30" }] },
      { model: "M(LPG)", aliases: ["M_LPG","M-LPG"], gasType: "LPG", gasLabel: "M(LPG) FOR L.P.G", page: 11,
        sizes: [{ size: "1", orifice: "0.7", thickness: "1-5" }, { size: "2", orifice: "0.9", thickness: "5-15" }, { size: "3", orifice: "1.1", thickness: "15-30" }] },
      { model: "ST8-A", gasType: "ACETYLENE", gasLabel: "ST8-A FOR ACE", page: 11,
        sizes: [{ size: "1", orifice: "0.7", thickness: "1-5" }, { size: "2", orifice: "0.9", thickness: "5-10" }, { size: "3", orifice: "1.1", thickness: "10-30" }, { size: "4", orifice: "1.3", thickness: "30-50" }] },
      { model: "ST8-P", gasType: "LPG", gasLabel: "ST8-P FOR L.P.G", page: 11,
        sizes: [{ size: "1", orifice: "0.7", thickness: "1-5" }, { size: "2", orifice: "0.9", thickness: "5-10" }, { size: "3", orifice: "1.1", thickness: "10-30" }, { size: "4", orifice: "1.3", thickness: "30-50" }] },
    ],
  },
  {
    code: "03",
    series: "BRITISH STYLE CUTTING TIP",
    models: [
      { model: "ANME", gasType: "ACETYLENE", gasLabel: "ANME FOR ACE", page: 12,
        sizes: [{ size: "1/32", orifice: "0.8", thickness: "3-10" }, { size: "3/64", orifice: "1.2", thickness: "10-25" }, { size: "1/16", orifice: "1.6", thickness: "25-75" }, { size: "5/64", orifice: "2.0", thickness: "75-125" }, { size: "3/32", orifice: "2.4", thickness: "125-175" }, { size: "7/64", orifice: "2.8", thickness: "175-225" }, { size: "1/8", orifice: "3.2", thickness: "225-300" }] },
      { model: "PNME", gasType: "LPG", gasLabel: "PNME FOR L.P.G", page: 12,
        sizes: [{ size: "1/64", orifice: "0.6", thickness: "1-3" }, { size: "1/32", orifice: "0.8", thickness: "3-10" }, { size: "3/64", orifice: "1.2", thickness: "10-25" }, { size: "1/16", orifice: "1.6", thickness: "25-75" }, { size: "5/64", orifice: "2.0", thickness: "75-125" }, { size: "3/32", orifice: "2.4", thickness: "125-175" }, { size: "7/64", orifice: "2.8", thickness: "175-225" }, { size: "1/8", orifice: "3.2", thickness: "225-300" }] },
    ],
  },
  {
    code: "04",
    series: "FRENCH STYLE CUTTING TIP",
    models: [
      { model: "G1-A", gasType: "ACETYLENE", gasLabel: "G1-A FOR ACE", page: 13,
        sizes: [{ size: "7/10", orifice: "0.7", thickness: "3-10" }, { size: "10/10", orifice: "1.0", thickness: "10-25" }, { size: "12/10", orifice: "1.2", thickness: "25-50" }, { size: "16/10", orifice: "1.6", thickness: "50-80" }, { size: "20/10", orifice: "2.0", thickness: "80-120" }, { size: "25/10", orifice: "2.5", thickness: "120-200" }, { size: "30/10", orifice: "3.0", thickness: "200-300" }] },
      { model: "G1-P", gasType: "LPG", gasLabel: "G1-P FOR L.P.G", page: 13,
        sizes: [{ size: "7/10", orifice: "0.7", thickness: "3-10" }, { size: "10/10", orifice: "1.0", thickness: "10-25" }, { size: "12/10", orifice: "1.2", thickness: "25-50" }, { size: "16/10", orifice: "1.6", thickness: "50-80" }, { size: "20/10", orifice: "2.0", thickness: "80-120" }, { size: "25/10", orifice: "2.5", thickness: "120-200" }, { size: "30/10", orifice: "3.0", thickness: "200-300" }] },
    ],
  },
  {
    code: "05",
    series: "AUSTRALIAN STYLE CUTTING TIP",
    models: [
      { model: "41", gasType: "ACETYLENE", gasLabel: "41 FOR ACE", page: 14,
        sizes: [{ size: "6", orifice: "0.6", thickness: "1-6" }, { size: "8", orifice: "0.8", thickness: "6-10" }, { size: "12", orifice: "1.2", thickness: "10-20" }, { size: "15", orifice: "1.5", thickness: "25-75" }, { size: "20", orifice: "2.0", thickness: "100-125" }, { size: "24", orifice: "2.4", thickness: "150-200" }, { size: "32", orifice: "3.2", thickness: "225-300" }, { size: "48", orifice: "4.8", thickness: "300-400" }] },
      { model: "44", gasType: "LPG", gasLabel: "44 FOR L.P.G", page: 14,
        sizes: [{ size: "6", orifice: "0.6", thickness: "3-6" }, { size: "8", orifice: "0.8", thickness: "6-10" }, { size: "12", orifice: "1.2", thickness: "10-20" }, { size: "15", orifice: "1.5", thickness: "25-75" }, { size: "20", orifice: "2.0", thickness: "100-125" }, { size: "24", orifice: "2.4", thickness: "150-200" }, { size: "32", orifice: "3.2", thickness: "225-300" }] },
    ],
  },
  {
    code: "06",
    series: "BRAZILIAN STYLE CUTTING TIP",
    models: [
      { model: "1502", gasType: "ACETYLENE", gasLabel: "1502 FOR ACE", page: 15,
        sizes: [{ size: "2", orifice: "0.8", thickness: "3-6" }, { size: "3", orifice: "0.9", thickness: "6-10" }, { size: "4", orifice: "1.0", thickness: "10-15" }, { size: "6", orifice: "1.5", thickness: "15-25" }, { size: "8", orifice: "2.0", thickness: "25-125" }, { size: "10", orifice: "2.4", thickness: "125-250" }, { size: "12", orifice: "3.0", thickness: "250-300" }] },
      { model: "1503", gasType: "LPG", gasLabel: "1503 FOR L.P.G", page: 15,
        sizes: [{ size: "2", orifice: "0.6", thickness: "3-6" }, { size: "3", orifice: "0.8", thickness: "6-10" }, { size: "4", orifice: "1.0", thickness: "10-25" }, { size: "6", orifice: "1.5", thickness: "25-50" }, { size: "8", orifice: "2.0", thickness: "50-100" }, { size: "10", orifice: "2.5", thickness: "100-150" }, { size: "12", orifice: "3.0", thickness: "150-200" }, { size: "14", orifice: "3.6", thickness: "200-250" }, { size: "16", orifice: "4.0", thickness: "250-350" }] },
    ],
  },
];

/** 全目录「型号」清单（用于报告里的覆盖率统计） */
export const CATALOG_MODEL_NAMES: string[] = CATALOG_SERIES.flatMap((s) => s.models.map((m) => m.model));
