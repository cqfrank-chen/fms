import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Alert, Button, Card, DatePicker, Empty, Form, Input, InputNumber, Modal, Segmented, Select, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { Order } from '../lib/types';
import OrderDetailModal from '../components/OrderDetailModal';
import type { SchedTask, VerifyResult, WorkCenter, ProcessInfo } from '../lib/scheduling';

const { Text } = Typography;
const BAR_H = 26;
const LAYER_GAP = 30;
const LANE_PAD = 6;
const PX_DAY_BY_SCALE: Record<string, number> = { day: 92, week: 44 };

const addDays = (_s: string, n: number): string => {
  const [y, m, d] = _s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};
const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const STATUS_COLOR = (t: SchedTask) => {
  if (t.progress >= 1) return '#52c41a';
  if (t.progress > 0) return '#faad14';
  return '#1677ff';
};
const barLabel = (t: SchedTask) => `${t.planNo}·行${t.lineId} ${Math.round(t.progress * 100)}%`;

type Drag = { id: number; startDay: number; lastDay: number; grabOff: number; origWc: string };

// =============== 内嵌：GanttLane ===============
function GanttLane({
  tasks, workCenters, onMoveBar, onClickBar, scale,
}: {
  tasks: SchedTask[];
  workCenters: WorkCenter[];
  onMoveBar: (lineId: number, wcKey: string, startDate: string) => Promise<void> | void;
  onClickBar: (t: SchedTask) => void;
  scale: 'day' | 'week';
}) {
  const { message } = AntApp.useApp();
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const PX_DAY = PX_DAY_BY_SCALE[scale] ?? 92;

  const axis = useMemo(() => {
    const sched = tasks.filter((t) => t.scheduled && t.startDate);
    if (sched.length === 0) {
      const start = todayISO();
      const days = 14;
      const list = Array.from({ length: days }, (_, i) => addDays(start, i));
      return { start, days, list, idxOf: (_s: string) => 0 };
    }
    const minS = sched.reduce((m, t) => (t.startDate! < m ? t.startDate! : m), sched[0].startDate!);
    const maxE = sched.reduce((m, t) => (t.endDate && t.endDate > m ? t.endDate : m), sched[0].endDate!);
    const start = addDays(minS, -3);
    const end = addDays(maxE, 3);
    const [y, m, d] = start.split('-').map(Number);
    const a = Date.UTC(y, m - 1, d);
    const [y2, m2, d2] = end.split('-').map(Number);
    const b = Date.UTC(y2, m2 - 1, d2);
    const days = Math.round((b - a) / 86400000) + 1;
    const list = Array.from({ length: days }, (_, i) => addDays(start, i));
    return { start, days, list, idxOf: (s: string) => list.indexOf(s) };
  }, [tasks]);

  const dayAt = (clientX: number) => {
    const rect = gridRef.current!.getBoundingClientRect();
    return Math.round((clientX - rect.left) / PX_DAY);
  };

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const idx = dayAt(ev.clientX) - d.grabOff;
      const lastDay = Math.max(0, Math.min(axis.days - 1, idx));
      if (lastDay === d.lastDay) return;
      d.lastDay = lastDay;
    };
    const onUp = async () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (d.lastDay === d.startDay) return;
      const newStart = axis.list[d.lastDay];
      const t = tasksRef.current.find((x) => x.lineId === d.id);
      if (!t) return;
      try {
        await onMoveBar(d.id, t.wcKey || 'cut', newStart);
        message.success(`已排 ${t.planNo}·行${t.lineId} 至 ${newStart}`);
      } catch (e: any) {
        message.error(`保存失败：${e?.message || e}`);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, scale]);

  const layout = useMemo(() => {
    const map = new Map<number, { left: number; top: number }>();
    const byWc = new Map<string, SchedTask[]>();
    for (const t of tasks) {
      if (!t.scheduled || !t.wcKey || !t.startDate) continue;
      const arr = byWc.get(t.wcKey) ?? [];
      arr.push(t);
      byWc.set(t.wcKey, arr);
    }
    for (const [, arr] of byWc) {
      arr.sort((a, b) => a.startDate!.localeCompare(b.startDate!));
      const layers: number[] = [];
      for (const t of arr) {
        const s = axis.idxOf(t.startDate!);
        if (s < 0) continue;
        const e = s + t.durDays - 1;
        let li = layers.findIndex((last) => s > last);
        if (li === -1) { li = layers.length; layers.push(e); } else layers[li] = e;
        map.set(t.lineId, { left: s * PX_DAY + 4, top: LANE_PAD + li * LAYER_GAP });
      }
    }
    return map;
  }, [tasks, axis, scale]);

  const onPointerDown = (e: React.PointerEvent, t: SchedTask) => {
    if (!t.scheduled || !t.startDate) return;
    e.preventDefault();
    const s = axis.idxOf(t.startDate);
    drag.current = { id: t.lineId, startDay: s, lastDay: s, grabOff: dayAt(e.clientX) - s, origWc: t.wcKey || '' };
  };

  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, overflowX: 'auto' }}>
      <div style={{ minWidth: axis.days * PX_DAY + 8 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 5 }}>
          <div style={{ width: 130, flexShrink: 0 }} />
          <div ref={gridRef} style={{ display: 'flex', flex: 1, position: 'relative' }}>
            {axis.list.map((d) => {
              const dt = new Date(d + 'T00:00:00Z');
              const dow = dt.getUTCDay();
              const isWeekend = dow === 0 || dow === 6;
              const isWeekStart = scale === 'week' && dow === 1; // 周一 = 周分隔线
              const titleDay = d.slice(5);
              return (
                <div
                  key={d}
                  title={d}
                  style={{
                    width: PX_DAY, flexShrink: 0, textAlign: 'center',
                    fontSize: scale === 'week' ? 10 : 11,
                    color: isWeekend ? '#bbb' : '#666',
                    borderLeft: isWeekStart ? '1px solid #d9d9d9' : '1px solid #f5f5f5',
                    background: isWeekend ? '#fafafa' : undefined,
                    padding: '2px 0',
                    lineHeight: '14px',
                  }}
                >
                  {scale === 'week' ? (
                    <>
                      <div>{dt.getUTCDate()}</div>
                      <div style={{ color: isWeekStart ? '#999' : 'transparent', height: 12, overflow: 'hidden' }}>{titleDay}</div>
                    </>
                  ) : (
                    <>
                      {titleDay}
                      <div style={{ color: '#bbb' }}>{['日', '一', '二', '三', '四', '五', '六'][dow]}</div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {workCenters.map((wc) => {
          const laneTasks = tasks.filter((t) => t.scheduled && t.wcKey === wc.key);
          const maxLayer = laneTasks.reduce((m, t) => Math.max(m, Math.round((layout.get(t.lineId)?.top ?? LANE_PAD - LAYER_GAP) / LAYER_GAP)), -1);
          return (
            <div key={wc.key} style={{ display: 'flex', borderBottom: '1px solid #f0f0f0', minWidth: axis.days * PX_DAY + 8 }}>
              <div style={{ width: 130, flexShrink: 0, padding: '8px', fontSize: 13, fontWeight: 500 }}>
                {wc.name}
                <div style={{ fontSize: 11, color: '#999' }}>{wc.machines} 台</div>
              </div>
              <div style={{ position: 'relative', flex: 1, background: '#fafafa', borderLeft: '1px solid #f0f0f0', height: LANE_PAD + (maxLayer + 1) * LAYER_GAP + 8, minHeight: 44 }}>
                {laneTasks.map((t) => {
                  const pos = layout.get(t.lineId);
                  if (!pos) return null;
                  return (
                    <div
                      key={t.lineId}
                      style={{
                        position: 'absolute',
                        left: pos.left,
                        top: pos.top,
                        width: t.durDays * PX_DAY - 8,
                        height: BAR_H,
                        background: STATUS_COLOR(t),
                        borderRadius: 4,
                        color: '#fff',
                        fontSize: 11,
                        lineHeight: `${BAR_H}px`,
                        padding: '0 8px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        cursor: 'grab',
                        boxSizing: 'border-box',
                        boxShadow: t.overdue ? '0 0 0 2px #ff4d4f' : undefined,
                        outline: t.coverDays != null ? '2px dashed #722ed1' : undefined,
                      }}
                      title={`${t.planNo}·行${t.lineId}｜${t.productName} ×${t.quantity}\n客户 ${t.customerName}\n交期 ${t.dueDate}｜进度 ${Math.round(t.progress * 100)}%`}
                      onPointerDown={(e) => onPointerDown(e, t)}
                      onClick={() => onClickBar(t)}
                    >
                      {barLabel(t)}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============== 调度面板 Modal ===============
function ScheduleModal({
  task, workCenters, processes, open, onCancel, onSubmit,
}: {
  task: SchedTask | null;
  workCenters: WorkCenter[];
  processes: ProcessInfo[];
  open: boolean;
  onCancel: () => void;
  onSubmit: (lineId: number, dto: { wcKey: string; startDate: string; coverDays: number | null }) => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const [wcKey, setWcKey] = useState<string>('cut');
  const [startDate, setStartDate] = useState<string>(todayISO());
  const [coverDays, setCoverDays] = useState<number | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  useEffect(() => {
    if (!task) return;
    setWcKey(task.wcKey || 'cut');
    setStartDate(task.startDate || todayISO());
    setCoverDays(task.coverDays ?? null);
  }, [task?.lineId, open]);

  useEffect(() => {
    if (!task || !open) return;
    let cancelled = false;
    fetch(`/api/scheduling/verify?lineId=${task.lineId}&wcKey=${encodeURIComponent(wcKey)}&startDate=${encodeURIComponent(startDate)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled) setVerify(j); })
      .catch(() => { if (!cancelled) setVerify(null); });
    return () => { cancelled = true; };
  }, [task?.lineId, wcKey, startDate, open]);

  const wcProcesses = useMemo(() => processes.filter((p) => p.wcKey === wcKey), [processes, wcKey]);

  const submit = async () => {
    if (!task) return;
    try {
      await onSubmit(task.lineId, { wcKey, startDate, coverDays });
      message.success(`已排 ${task.planNo}·行${task.lineId}`);
      onCancel();
    } catch (e: any) {
      message.error(`保存失败：${e?.message || e}`);
    }
  };
  const unschedule = async () => {
    if (!task) return;
    await fetch(`/api/scheduling/plan-lines/${task.lineId}/schedule`, { method: 'DELETE' });
    message.success(`已取消排期 ${task.planNo}·行${task.lineId}`);
    onCancel();
  };

  return (
    <Modal open={open} onCancel={onCancel} footer={null} title={task ? `排期：${task.planNo}·行${task.lineId}` : '排期'} width={520}>
      {task && (
        <>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary">产品行</Text>　{task.productName} ×{task.quantity}　<Text type="secondary">客户</Text>　{task.customerName}
          </div>
          <Form layout="vertical" size="small">
            <Form.Item label="排入工序（泳道）" required>
              <Select value={wcKey} onChange={(v) => setWcKey(v as string)}>
                {workCenters.map((w) => <Select.Option key={w.key} value={w.key}>{w.name}（{w.machines}台）</Select.Option>)}
              </Select>
              <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>该泳道工序：{wcProcesses.map((p) => p.name).join('、') || '—'}</div>
            </Form.Item>
            <Form.Item label="开始日期" required>
              <DatePicker value={dayjs(startDate)} onChange={(d) => setStartDate(d ? d.format('YYYY-MM-DD') : todayISO())} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label="工期（覆盖天数；空=按 qty×单件耗时÷设备数÷8h 自动推算）">
              <InputNumber min={1} value={coverDays ?? undefined} onChange={(v) => setCoverDays(v as number | null)} placeholder={`自动推算约 ${verify?.autoDays ?? '?'} 天`} style={{ width: 200 }} />
            </Form.Item>
          </Form>
          {verify && (
            <Alert
              type={verify.overdue ? 'error' : 'info'}
              showIcon
              style={{ marginBottom: 8 }}
              title={`预计工期 ${verify.coverDays} 天（${verify.startDate} → ${verify.endDate}）｜泳道已有 ${verify.laneLoad} 个任务｜客户交期 ${verify.dueDate ?? '—'}`}
              description={verify.durationHint}
            />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {task.scheduled && <Button danger onClick={unschedule}>取消排期</Button>}
            <Button onClick={onCancel}>关闭</Button>
            <Button type="primary" onClick={submit}>确认排期</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// =============== 任务简介 Modal ===============
function TaskModal({ task, open, onCancel, onOpenOrder }: {
  task: SchedTask | null;
  open: boolean;
  onCancel: () => void;
  onOpenOrder: (t: SchedTask) => void;
}) {
  return (
    <Modal open={open} onCancel={onCancel} footer={null} title={task ? `${task.planNo} 行${task.lineId}｜${task.productName}` : '任务简介'} width={460}>
      {task && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div><Text type="secondary">来源</Text>　{task.orderNo}（订单 {task.orderId}）</div>
          <div><Text type="secondary">客户</Text>　{task.customerName}</div>
          <div><Text type="secondary">计划单</Text>　{task.planNo}（{task.planStatus}）</div>
          <div><Text type="secondary">数量</Text>　{task.quantity} 只｜完成 {task.completed}（{Math.round(task.progress * 100)}%）</div>
          <div><Text type="secondary">排程</Text>　{task.scheduled ? `${task.startDate} → ${task.endDate}（${task.durDays} 天，${task.wcName}）` : '未排期'}{task.coverDays != null ? '（工期已覆盖）' : ''}</div>
          <div><Text type="secondary">交期</Text>　{task.dueDate ?? '—'} {task.overdue ? <Tag color="red">⚠预计超期</Tag> : null}</div>
          {task.engraving && <div><Text type="secondary">刻字</Text>　{task.engraving}</div>}
          {task.packaging && (
            <div><Text type="secondary">包装</Text>　
              {Object.entries(task.packaging).filter(([, v]) => v).map(([k]) => <Tag key={k}>{k}</Tag>)}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#999' }}>单价耗时（unitSeconds）：{task.unitSeconds ?? '未配置'}</div>
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
            <Button size="small" onClick={onCancel}>关闭</Button>
            <Button size="small" type="primary" style={{ marginLeft: 8 }} onClick={() => onOpenOrder(task)}>查看完整订单 →</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// =============== 排程看板主页面 ===============
export default function SchedulingPage() {
  const { message } = AntApp.useApp();
  const [tasks, setTasks] = useState<SchedTask[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [scale, setScale] = useState<'day' | 'week'>('day');
  const [scheduleTarget, setScheduleTarget] = useState<SchedTask | null>(null);
  const [taskDetail, setTaskDetail] = useState<SchedTask | null>(null);
  const [pendingKw, setPendingKw] = useState('');
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);

  const load = useCallback(async () => {
    const [t, w, p] = await Promise.all([
      fetch('/api/scheduling/tasks').then((r) => r.json()),
      fetch('/api/scheduling/work-centers').then((r) => r.json()),
      fetch('/api/scheduling/processes').then((r) => r.json()),
    ]);
    setTasks(t);
    setWorkCenters(w);
    setProcesses(p);
  }, []);

  useEffect(() => { load(); }, [load]);

  const scheduled = tasks.filter((t) => t.scheduled);
  const kw = pendingKw.trim().toLowerCase();
  const pending = tasks
    .filter((t) => !t.scheduled)
    .filter((t) => !kw || [t.planNo, t.productName, t.customerName, t.engraving ?? '']
      .some((s) => s.toLowerCase().includes(kw)))
    .sort((a, b) => (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99'));

  const moveBar = async (lineId: number, wcKey: string, startDate: string) => {
    const t = tasks.find((x) => x.lineId === lineId);
    await fetch(`/api/scheduling/plan-lines/${lineId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wcKey, startDate, coverDays: t?.coverDays ?? null }),
    });
    await load();
  };

  const submitSchedule = async (lineId: number, dto: { wcKey: string; startDate: string; coverDays: number | null }) => {
    await fetch(`/api/scheduling/plan-lines/${lineId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    await load();
  };

  const openOrder = async (t: SchedTask) => {
    setTaskDetail(null);
    try {
      const res = await fetch(`/api/orders/${t.orderId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOrderDetail(await res.json());
    } catch (e: any) {
      message.error(`订单加载失败：${e?.message || e}`);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {/* 待排区 */}
      <Card title={`待排区（已确认计划单·未排期 ${pending.length}）`} size="small" style={{ width: 280, flexShrink: 0 }}>
        <Input.Search placeholder="筛 单号/产品/客户/刻字" size="small" allowClear onSearch={setPendingKw} style={{ marginBottom: 8 }} />
        {pending.length === 0 && <Empty description={kw ? '无匹配' : '池空了'} />}
        {pending.map((t) => (
          <div
            key={t.lineId}
            onClick={() => setScheduleTarget(t)}
            style={{ border: '1px solid #e8e8e8', borderLeft: '4px solid #1677ff', borderRadius: 6, padding: '8px 10px', marginBottom: 8, cursor: 'pointer' }}
            title="点击 → 排期面板"
          >
            <div style={{ fontWeight: 500 }}>{t.planNo}·行{t.lineId}</div>
            <div style={{ fontSize: 11, color: '#666' }}>{t.productName}{t.engraving ? ` ✒${t.engraving}` : ''}</div>
            <div style={{ fontSize: 11, color: '#1677ff' }}>{t.quantity} 只 · 交期 {t.dueDate}</div>
          </div>
        ))}
      </Card>

      {/* 看板 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space style={{ marginBottom: 8 }}>
          <Segmented options={[{ label: '日', value: 'day' }, { label: '周', value: 'week' }]} value={scale} onChange={(v) => setScale(v as any)} />
          <Text type="secondary">蓝=待办 / 黄=进行中 / 绿=完成 / 红框=超期 / 紫虚线框=工期已人工覆盖</Text>
          <Button onClick={load} size="small">刷新</Button>
        </Space>
        {scheduled.length === 0 ? (
          <Empty description="无已排期任务（请到左侧待排区点击排期）" />
        ) : (
          <GanttLane tasks={tasks} workCenters={workCenters} onMoveBar={moveBar} onClickBar={setTaskDetail} scale={scale} />
        )}
      </div>

      <ScheduleModal
        task={scheduleTarget}
        workCenters={workCenters}
        processes={processes}
        open={!!scheduleTarget}
        onCancel={() => setScheduleTarget(null)}
        onSubmit={submitSchedule}
      />
      <TaskModal task={taskDetail} open={!!taskDetail} onCancel={() => setTaskDetail(null)} onOpenOrder={openOrder} />
      <OrderDetailModal order={orderDetail} open={!!orderDetail} onClose={() => setOrderDetail(null)} />
    </div>
  );
}