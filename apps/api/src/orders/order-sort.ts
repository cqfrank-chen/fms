import { BadRequestException } from '@nestjs/common';
import { ORDERS_DUE_DATE_TBD } from '../db/schema';

/**
 * 订单列表「多列组合排序」（sort 参数 → 白名单校验 → 多键依次比较）
 * =====================================================================================
 * 接口形态：GET /api/orders?sort=dueDate:desc,customer:asc,status:asc
 *   · 逗号分隔多个排序键，**从左到右 = 优先级从高到低**（与界面表头显示的 1/2/3 序号一致）；
 *   · 每个键写成 `字段:方向`，方向只认 asc（升序）/ desc（降序），大小写不敏感；
 *     省略方向（只写字段名）时按 asc 处理；
 *   · 字段必须在白名单内，否则 **400**（中文提示列出全部可用字段）；
 *   · 同一字段重复出现时保留**第一次**出现的键（后面的重复项忽略）；
 *   · 参数缺省/为空 → 默认排序 `dueDate:desc`（交期从大到小）。
 *
 * 排序规则（三条，界面上「重置排序」也回到这套默认）：
 *   1) **缺失值恒定排最后**：NULL / 空串 / 交期待定 不参与升降序，一律沉底；
 *   2) 非缺失值按该键的 asc/desc 比较；
 *   3) 所有键都相等时，**恒定**追加「创建时间 DESC, 订单 id DESC」兜底
 *      —— 顺序稳定，翻页/刷新/重新查询不会同一批单据乱跳。
 *
 * 「交期待定」的识别（见 db/schema.ts 的 ORDERS_DUE_DATE_TBD）：
 *   orders.due_date 是 NOT NULL，识单缺交期时写哨兵日 2099-12-31 并把 due_date_tbd 置 true。
 *   本模块判定「待定」= due_date_tbd === true **或** 交期 >= 哨兵日（两个信号都查，防脏数据）；
 *   待定单一律当成「无交期」沉底 —— 否则默认 DESC 会把这批假日期(2099)顶到列表最前面。
 *
 * 金额/开票状态/待补项数/产品行数 这几列在 SQL 里并不存在（由 attachLines 实时派生：
 * 订单金额=按分定点 Σ 数量×单价，开票状态=已开票分值与订单金额分值的三态比较）。
 * 为保证「排序用的值」与「列表显示的值」严格同源（不会一个按 SQL 近似值、一个按派生值），
 * 这里统一在拿到 attachLines 结果后做视图排序；orders 列表本身不分页（前端分页），
 * 排序不改变返回集合，只改变顺序。
 */

/** 排序方向 */
export type OrderSortDir = 'asc' | 'desc';

/** 排序字段白名单（键名与前端列 columnKey 一一对应） */
export const ORDER_SORT_FIELD_KEYS = [
  'dueDate', 'orderNo', 'poNo', 'customer', 'status', 'invoiceState',
  'amount', 'invoiced', 'pendingCount', 'createdAt', 'lineCount',
] as const;

export type OrderSortField = (typeof ORDER_SORT_FIELD_KEYS)[number];

/** 排序字段 → 中文列名（错误提示与文档用） */
export const ORDER_SORT_FIELD_LABEL: Record<OrderSortField, string> = {
  dueDate: '交期',
  orderNo: '订单号',
  poNo: '客户 PO 号',
  customer: '客户',
  status: '状态',
  invoiceState: '开票状态',
  amount: '订单金额',
  invoiced: '已开票金额',
  pendingCount: '待补项数量',
  createdAt: '创建时间',
  lineCount: '产品行数',
};

/** 一条排序键 */
export interface OrderSortKey {
  field: OrderSortField;
  dir: OrderSortDir;
}

/** 默认排序：交期 DESC（交期待定沉底，同级再按创建时间 DESC — 见文件头规则 3） */
export const DEFAULT_ORDER_SORT: OrderSortKey[] = [{ field: 'dueDate', dir: 'desc' }];

/** 是否白名单字段 */
export const isOrderSortField = (v: string): v is OrderSortField =>
  (ORDER_SORT_FIELD_KEYS as readonly string[]).includes(v);

/** 白名单字段的中文清单（拼 400 提示用） */
const FIELD_LIST_TEXT = ORDER_SORT_FIELD_KEYS
  .map((k) => `${k}（${ORDER_SORT_FIELD_LABEL[k]}）`)
  .join('、');

/**
 * 解析 sort 参数（纯函数，便于单测）。
 * 非法字段/非法方向 → BadRequestException（Nest 统一转 400，message 为中文）。
 */
export function parseOrderSort(raw?: string | null): OrderSortKey[] {
  const text = (raw ?? '').trim();
  if (!text) return DEFAULT_ORDER_SORT.map((k) => ({ ...k }));
  const keys: OrderSortKey[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(',')) {
    const item = piece.trim();
    if (!item) continue; // 容忍多余逗号/空格（'a:asc,,b:desc'）
    const [fieldRaw, dirRaw, ...rest] = item.split(':');
    if (rest.length) {
      throw new BadRequestException(`排序参数「${item}」格式不正确：应写成 字段:方向（如 dueDate:desc），多个键用逗号分隔`);
    }
    const field = fieldRaw.trim();
    if (!isOrderSortField(field)) {
      throw new BadRequestException(`不支持的排序字段「${field}」：可用字段有 ${FIELD_LIST_TEXT}`);
    }
    const dirText = (dirRaw ?? '').trim().toLowerCase();
    let dir: OrderSortDir;
    if (dirText === '' || dirText === 'asc') dir = 'asc';
    else if (dirText === 'desc') dir = 'desc';
    else throw new BadRequestException(`排序方向「${dirRaw}」无效：只支持 asc（升序）/ desc（降序）`);
    if (seen.has(field)) continue; // 同字段重复 → 保留第一次
    seen.add(field);
    keys.push({ field, dir });
  }
  return keys.length ? keys : DEFAULT_ORDER_SORT.map((k) => ({ ...k }));
}

/** 排序键 → 参数字符串（前端回显/日志用，与 parseOrderSort 互逆） */
export const formatOrderSort = (keys: OrderSortKey[]): string =>
  keys.map((k) => `${k.field}:${k.dir}`).join(',');

// =====================================================================================
// 取值与比较
// =====================================================================================

/** 排序取值载体（缺省/为 null 的字段按「缺失」处理；比较规则见文件头） */
export interface OrderSortValues {
  /** 交期（ISO 串或 Date）；待定单请同时给 dueDateTbd 或直接给哨兵日 */
  dueDate?: string | Date | null;
  /** 交期待定标记（I17）：true → 视为无交期 */
  dueDateTbd?: boolean | null;
  orderNo?: string | null;
  poNo?: string | null;
  customerName?: string | null;
  status?: string | null;
  invoiceState?: string | null;
  /** 订单金额（分） */
  totalAmountCents?: number | null;
  /** 已开票金额（分，含税净额，只计未作废票） */
  invoicedCents?: number | null;
  /** 单头待补项数量 */
  pendingCount?: number | null;
  /** 产品行数 */
  lineCount?: number | null;
  createdAt?: string | Date | null;
}

/** 订单列表行 → 排序取值（金额/开票状态/待补数/行数取 attachLines 已算好的同一份派生值） */
export interface OrderSortRowInput extends OrderSortValues {
  pendingItems?: Array<unknown> | null;
  lines?: Array<unknown> | null;
}

export const orderToSortValues = (o: OrderSortRowInput): OrderSortValues => ({
  dueDate: o.dueDate,
  dueDateTbd: o.dueDateTbd,
  orderNo: o.orderNo,
  poNo: o.poNo,
  customerName: o.customerName,
  status: o.status,
  invoiceState: o.invoiceState,
  totalAmountCents: o.totalAmountCents,
  invoicedCents: o.invoicedCents,
  pendingCount: Array.isArray(o.pendingItems) ? o.pendingItems.length : 0,
  lineCount: Array.isArray(o.lines) ? o.lines.length : 0,
  createdAt: o.createdAt,
});

/**
 * 状态/开票状态的业务序（不是字母序）：
 *   · 订单五态按生命周期：草稿 → 已确认 → 生产中 → 已完成 → 已取消（见 db/schema.ts 的 STATUSES）；
 *   · 开票状态按开票进度：未开票 → 部分开票 → 已开完。
 * 未知取值（脏数据/越界枚举）给 99，排在已知取值之后但不算「缺失」。
 */
export const ORDER_STATUS_RANK: Record<string, number> = {
  draft: 1, confirmed: 2, production: 3, completed: 4, cancelled: 5,
};
export const INVOICE_STATE_RANK: Record<string, number> = { none: 0, partial: 1, done: 2 };
const UNKNOWN_RANK = 99;

/** 哨兵日时间戳（毫秒）：2099-12-31T00:00:00Z —— 落库时就是按 UTC 零点写入的 */
const TBD_MILLIS = Date.parse(ORDERS_DUE_DATE_TBD + 'T00:00:00Z');

/** 交期时间戳（毫秒）；待定/非法交期 → null（= 缺失） */
const dueDateMillis = (v: OrderSortValues): number | null => {
  if (v.dueDateTbd) return null;
  const raw = v.dueDate;
  if (raw == null || raw === '') return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  if (!Number.isFinite(ms)) return null;
  // 兜底：date 列本身落到哨兵日（due_date_tbd 漏标）也按待定处理
  if (ms >= TBD_MILLIS) return null;
  return ms;
};

/** 时间戳（毫秒）→ 分钟级；非法 → null（缺失） */
const createdMillis = (v: OrderSortValues): number | null => {
  const raw = v.createdAt;
  if (raw == null || raw === '') return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
};

/** 数值化（缺失 → null）：空串/NaN/undefined 都不算有效值 */
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 文本化（缺失 → null）：null/纯空白 视为缺失 */
const textOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v);
  return s.trim() === '' ? null : s;
};

/** 字段取值：{ missing: 是否缺失, value: 非缺失时的可比较值 } */
interface FieldAccessor {
  missing: (v: OrderSortValues) => boolean;
  value: (v: OrderSortValues) => number | string;
}

const ACCESSORS: Record<OrderSortField, FieldAccessor> = {
  dueDate: {
    missing: (v) => dueDateMillis(v) == null,
    value: (v) => dueDateMillis(v) as number,
  },
  orderNo: {
    missing: (v) => textOrNull(v.orderNo) == null,
    value: (v) => textOrNull(v.orderNo) as string,
  },
  poNo: {
    missing: (v) => textOrNull(v.poNo) == null,
    value: (v) => textOrNull(v.poNo) as string,
  },
  customer: {
    missing: (v) => textOrNull(v.customerName) == null,
    value: (v) => textOrNull(v.customerName) as string,
  },
  status: {
    missing: (v) => textOrNull(v.status) == null,
    value: (v) => ORDER_STATUS_RANK[String(v.status)] ?? UNKNOWN_RANK,
  },
  invoiceState: {
    missing: (v) => textOrNull(v.invoiceState) == null,
    value: (v) => INVOICE_STATE_RANK[String(v.invoiceState)] ?? UNKNOWN_RANK,
  },
  amount: {
    missing: (v) => numOrNull(v.totalAmountCents) == null,
    value: (v) => numOrNull(v.totalAmountCents) as number,
  },
  invoiced: {
    missing: (v) => numOrNull(v.invoicedCents) == null,
    value: (v) => numOrNull(v.invoicedCents) as number,
  },
  pendingCount: {
    missing: (v) => numOrNull(v.pendingCount) == null,
    value: (v) => numOrNull(v.pendingCount) as number,
  },
  createdAt: {
    missing: (v) => createdMillis(v) == null,
    value: (v) => createdMillis(v) as number,
  },
  lineCount: {
    missing: (v) => numOrNull(v.lineCount) == null,
    value: (v) => numOrNull(v.lineCount) as number,
  },
};

/** 单值比较：数字按大小，字符串按码点序（与 Postgres COLLATE "C" 一致，避免各环境 collation 差异） */
function compareValue(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : (a < b ? -1 : 1);
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * 多键比较函数（纯函数，单测覆盖）。
 * 返回 <0 / 0 / >0，可直接喂给 Array.prototype.sort。
 */
export function compareOrderSortValues(
  a: OrderSortValues,
  b: OrderSortValues,
  keys: OrderSortKey[] = DEFAULT_ORDER_SORT,
): number {
  for (const key of keys) {
    const acc = ACCESSORS[key.field];
    const am = acc.missing(a);
    const bm = acc.missing(b);
    // 规则 1：缺失值恒定沉底（与 asc/desc 无关）；两侧都缺失 → 交给下一个键
    if (am !== bm) return am ? 1 : -1;
    if (am && bm) continue;
    const c = compareValue(acc.value(a), acc.value(b));
    if (c !== 0) return key.dir === 'desc' ? -c : c;
  }
  return 0;
}

/**
 * 稳定排序：用户键之后恒定追加「创建时间 DESC, id DESC」兜底（规则 3）。
 * id 由 toValues 映射进来的 createdAt 之外单独处理 —— 为保证纯函数性，
 * 这里用「原数组下标」作最后一级，等价于「先按用户键排，再保持取数顺序」，
 * 而取数顺序本身就是 SQL 的 ORDER BY id DESC（见 OrdersService.findAll）。
 */
export function sortOrdersByKeys<T>(
  rows: T[],
  keys: OrderSortKey[],
  toValues: (row: T) => OrderSortValues,
): T[] {
  const indexed = rows.map((row, i) => ({ row, i, v: toValues(row) }));
  indexed.sort((x, y) => {
    const c = compareOrderSortValues(x.v, y.v, keys);
    if (c !== 0) return c;
    // 兜底①：创建时间 DESC（同交期的草稿单：新单在前）
    const cd = compareValue(
      createdMillis(y.v) ?? Number.NEGATIVE_INFINITY,
      createdMillis(x.v) ?? Number.NEGATIVE_INFINITY,
    );
    return cd !== 0 ? cd : x.i - y.i; // 兜底②：保持取数顺序（SQL ORDER BY id DESC）
  });
  return indexed.map((x) => x.row);
}
