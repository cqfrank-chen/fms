// I10 spike 共享演示数据：模拟"已确认计划单行 → 排期任务"
// 工序泳道 = 6 道聚合工序（原型/票05 的 6 工作中心展示层）
export const WC = [
  { key: 'cut', name: '下料', machines: 2 },
  { key: 'turn', name: '车削', machines: 2 },
  { key: 'drill', name: '钻孔(丙烷)', machines: 1 },
  { key: 'thread', name: '螺纹', machines: 1 },
  { key: 'finish', name: '抛光/清洗', machines: 1 },
  { key: 'pack', name: '测试/包装', machines: 2 },
] as const;
export type WcKey = (typeof WC)[number]['key'];

export interface SchedTask {
  id: number;
  ps: string; // 计划单号
  line: number; // 行号（1 起）
  product: string;
  customer: string;
  qty: number;
  wc: WcKey; // 排入工序泳道
  start: string; // YYYY-MM-DD
  durDays: number; // 天数（推算/覆盖）
  status: 'todo' | 'wip' | 'done';
  progress: number; // 0-1
  due: string; // 客户交期
  overdue?: boolean; // 超期标红
  override?: boolean; // 工期是否人工覆盖
}

export const TASKS: SchedTask[] = [
  { id: 1, ps: 'PS-0905-01', line: 1, product: 'ANM-40', customer: 'Weldclass(澳)', qty: 2000, wc: 'cut', start: '2026-09-07', durDays: 2, status: 'done', progress: 1, due: '2026-09-12' },
  { id: 2, ps: 'PS-0905-01', line: 2, product: 'PNM-50', customer: 'Weldclass(澳)', qty: 1000, wc: 'cut', start: '2026-09-07', durDays: 2, status: 'wip', progress: 0.5, due: '2026-09-12' },
  { id: 3, ps: 'PS-0904-02', line: 1, product: '6290-6', customer: 'Tokentools(澳)', qty: 3000, wc: 'cut', start: '2026-09-08', durDays: 2, status: 'todo', progress: 0, due: '2026-09-15' },
  { id: 4, ps: 'PS-0905-01', line: 1, product: 'ANM-40', customer: 'Weldclass(澳)', qty: 2000, wc: 'turn', start: '2026-09-09', durDays: 3, status: 'wip', progress: 0.3, due: '2026-09-12' },
  { id: 5, ps: 'PS-0904-02', line: 1, product: '6290-6', customer: 'Tokentools(澳)', qty: 3000, wc: 'turn', start: '2026-09-10', durDays: 3, status: 'todo', progress: 0, due: '2026-09-15' },
  { id: 6, ps: 'PS-0904-01', line: 2, product: '101-2', customer: 'Unimig(澳)', qty: 1500, wc: 'drill', start: '2026-09-07', durDays: 2, status: 'todo', progress: 0, due: '2026-09-11', overdue: true },
  { id: 7, ps: 'PS-0905-01', line: 1, product: 'ANM-40', customer: 'Weldclass(澳)', qty: 2000, wc: 'drill', start: '2026-09-09', durDays: 3, status: 'todo', progress: 0, due: '2026-09-12' },
  { id: 8, ps: 'PS-0904-02', line: 1, product: '6290-6', customer: 'Tokentools(澳)', qty: 3000, wc: 'thread', start: '2026-09-09', durDays: 2, status: 'todo', progress: 0, due: '2026-09-15' },
  { id: 9, ps: 'PS-0905-01', line: 2, product: 'PNM-50', customer: 'Weldclass(澳)', qty: 1000, wc: 'thread', start: '2026-09-12', durDays: 2, status: 'todo', progress: 0, due: '2026-09-12', overdue: true },
  { id: 10, ps: 'PS-0904-01', line: 2, product: '101-2', customer: 'Unimig(澳)', qty: 1500, wc: 'finish', start: '2026-09-14', durDays: 1, status: 'todo', progress: 0, due: '2026-09-11', overdue: true, override: true },
  { id: 11, ps: 'PS-0905-01', line: 1, product: 'ANM-40', customer: 'Weldclass(澳)', qty: 2000, wc: 'finish', start: '2026-09-12', durDays: 1, status: 'todo', progress: 0, due: '2026-09-12', overdue: true },
  { id: 12, ps: 'PS-0904-02', line: 1, product: '6290-6', customer: 'Tokentools(澳)', qty: 3000, wc: 'pack', start: '2026-09-15', durDays: 2, status: 'todo', progress: 0, due: '2026-09-15' },
];

export const wcName = (k: WcKey) => WC.find((w) => w.key === k)?.name ?? k;
export const barLabel = (t: SchedTask) => `${t.ps}·行${t.line}`;
export const barTitle = (t: SchedTask) =>
  `${t.ps} 行${t.line}｜${t.product} ×${t.qty}\n客户 ${t.customer}｜工序 ${wcName(t.wc)}\n交期 ${t.due}｜进度 ${Math.round(t.progress * 100)}%`;
