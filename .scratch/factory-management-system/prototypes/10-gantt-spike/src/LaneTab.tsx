import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Modal, Tag, Typography, Alert } from 'antd';
import { TASKS, WC, SchedTask, barLabel, barTitle, wcName } from './data';
import dayjs from 'dayjs';

const { Text } = Typography;

// ===== 目标形态：6 工序泳道 + 绝对定位任务块 + 贪心分层（自研可行性参考，含天级拖拽） =====
const PX_DAY = 92;
const BAR_H = 26;
const LAYER_GAP = 30;
const LANE_PAD = 6;

type DragState = { id: number; startDay: number; lastDay: number; grabOff: number } | null;

export default function LaneTab() {
  const { message } = AntApp.useApp();
  const [tasks, setTasks] = useState<SchedTask[]>(TASKS);
  const [sel, setSel] = useState<SchedTask | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState>(null);

  const axis = useMemo(() => {
    const min = dayjs(TASKS.reduce((m, t) => (t.start < m ? t.start : m), '9999-99-99'));
    const max = dayjs(TASKS.reduce((m, t) => (dayjs(t.start).add(t.durDays, 'day').isAfter(m) ? dayjs(t.start).add(t.durDays, 'day') : m), dayjs(TASKS[0].start).add(TASKS[0].durDays, 'day')));
    const start = min.add(-1, 'day');
    const days = max.diff(start, 'day') + 2;
    const list = Array.from({ length: days }, (_, i) => start.add(i, 'day').format('YYYY-MM-DD'));
    return { start, days, list };
  }, []);

  const lay = useMemo(() => {
    const map = new Map<number, { left: number; top: number }>();
    const byWc = new Map<string, SchedTask[]>();
    tasks.forEach((t) => {
      const arr = byWc.get(t.wc) ?? [];
      arr.push(t);
      byWc.set(t.wc, arr);
    });
    for (const wc of WC) {
      const arr = (byWc.get(wc.key) ?? []).slice().sort((a, b) => a.start.localeCompare(b.start));
      const layers: number[] = []; // 每层最后一个任务的结束 day 偏移（< startDay 即空闲）
      for (const t of arr) {
        const s = dayjs(t.start).diff(axis.start, 'day');
        const e = s + t.durDays - 1;
        let li = layers.findIndex((last) => s > last);
        if (li === -1) { li = layers.length; layers.push(e); } else layers[li] = e;
        map.set(t.id, { left: s * PX_DAY + 4, top: LANE_PAD + li * LAYER_GAP });
      }
    }
    return map;
  }, [tasks, axis]);

  const barColor = (t: SchedTask) =>
    t.status === 'done' ? '#52c41a' : t.status === 'wip' ? '#faad14' : '#1677ff';
  const barStyle = (t: SchedTask): React.CSSProperties => {
    const p = lay.get(t.id)!;
    return {
      position: 'absolute',
      left: p.left,
      top: p.top,
      width: t.durDays * PX_DAY - 8,
      height: BAR_H,
      background: barColor(t),
      borderRadius: 4,
      color: '#fff',
      fontSize: 11,
      lineHeight: `${BAR_H}px`,
      padding: '0 8px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      cursor: 'grab',
      boxSizing: 'border-box',
      zIndex: t.status === 'wip' ? 3 : 2,
      boxShadow: t.overdue ? '0 0 0 2px #ff4d4f' : undefined,
      outline: t.override ? '2px dashed #722ed1' : undefined,
      opacity: drag.current?.id === t.id ? 0.6 : 1,
      userSelect: 'none',
    } as React.CSSProperties;
  };

  const dayAt = (clientX: number) => {
    const rect = gridRef.current!.getBoundingClientRect();
    return Math.round((clientX - rect.left) / PX_DAY);
  };

  // 拖拽改挂 window 级监听（pointer capture 在自动化/嵌套场景不稳，此处最稳）
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const idx = dayAt(ev.clientX) - d.grabOff;
      const max = axis.days - durDaysOf(d.id);
      const lastDay = Math.max(0, Math.min(max, idx));
      if (lastDay === d.lastDay) return;
      d.lastDay = lastDay;
      setTasks((prev) => prev.map((x) => (x.id === d.id ? { ...x, start: axis.list[lastDay] } : x)));
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const task = tasksRef.current.find((x) => x.id === d.id);
      if (!task || d.lastDay === d.startDay) return;
      const from = axis.list[d.startDay];
      const to = axis.list[d.lastDay];
      message.success(`[自研泳道] 拖拽回调 onDateChange：任务 ${barLabel(task)} 开始 ${from} → ${to}`);
      const w: any = window;
      w.__laneLog = w.__laneLog || [];
      w.__laneLog.push(`拖拽回调 onDateChange：${barLabel(task)} ${from} → ${to}`);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis]);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const durDaysOf = (id: number) => tasksRef.current.find((x) => x.id === id)?.durDays ?? 1;

  const onPointerDown = (e: React.PointerEvent, t: SchedTask) => {
    if (t.status === 'done') return;
    e.preventDefault();
    // 记录抓取点相对开始日的偏移，移动时扣除，避免"条内抓点"造成跳天
    const startDay = dayjs(t.start).diff(axis.start, 'day');
    drag.current = { id: t.id, startDay, lastDay: startDay, grabOff: dayAt(e.clientX) - startDay };
  };

  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 8 }} title="这是 6 工序泳道目标形态的自研参考实现：同一泳道重叠任务按贪心分层垂直错开，蓝条可按住左右拖动（天级吸附），绿=已完成/黄=进行中/红框=超期/紫虚线框=工期人工覆盖。候选库若无法表达该形态即视为模型不匹配。" />
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {WC.map((w) => (
          <Tag key={w.key} color="blue">{w.name} ×{w.machines}台</Tag>
        ))}
      </div>
      <div style={{ border: '1px solid #eee', borderRadius: 8, overflowX: 'auto' }}>
        <div style={{ minWidth: axis.days * PX_DAY + 8 }}>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={{ width: 130, flexShrink: 0 }} />
            <div ref={gridRef} style={{ display: 'flex', flex: 1, position: 'relative' }}>
              {axis.list.map((d, i) => {
                const dt = dayjs(d);
                const isWeekend = dt.day() === 0 || dt.day() === 6;
                return (
                  <div key={d} style={{ width: PX_DAY, flexShrink: 0, textAlign: 'center', fontSize: 11, color: isWeekend ? '#bbb' : '#666', borderLeft: '1px solid #f5f5f5', background: isWeekend ? '#fafafa' : undefined, padding: '4px 0' }}>
                    {dt.format('MM-DD')}
                    <div style={{ color: '#bbb' }}>{dt.format('ddd')}</div>
                  </div>
                );
              })}
            </div>
          </div>
          {WC.map((wc) => {
            const laneTasks = tasks.filter((t) => t.wc === wc.key);
            const maxLayer = laneTasks.reduce((m, t) => Math.max(m, Math.round((lay.get(t.id)!.top - LANE_PAD) / LAYER_GAP)), -1);
            return (
              <div key={wc.key} style={{ display: 'flex', borderBottom: '1px solid #f0f0f0', minWidth: axis.days * PX_DAY + 8 }}>
                <div style={{ width: 130, flexShrink: 0, padding: '8px', fontSize: 13, fontWeight: 500 }}>{wc.name}</div>
                <div style={{ position: 'relative', flex: 1, background: '#fafafa', borderLeft: '1px solid #f0f0f0', height: LANE_PAD + (maxLayer + 1) * LAYER_GAP + 8, minHeight: 40 }}>
                  {laneTasks.map((t) => (
                    <div
                      key={t.id}
                      style={barStyle(t)}
                      title={barTitle(t)}
                      onPointerDown={(e) => onPointerDown(e, t)}
                      onClick={() => setSel(t)}
                    >
                      {barLabel(t)} {Math.round(t.progress * 100)}%
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Modal open={!!sel} onCancel={() => setSel(null)} footer={null} title={sel ? `任务简介：${sel.ps} 行${sel.line}` : ''} width={460}>
        {sel && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><Text type="secondary">产品行</Text>　{sel.product} ×{sel.qty} 只（{wcName(sel.wc)}）</div>
            <div><Text type="secondary">客户</Text>　{sel.customer}</div>
            <div><Text type="secondary">交期</Text>　{sel.due} {sel.overdue ? <Tag color="red">已超期</Tag> : null}</div>
            <div><Text type="secondary">排程</Text>　{sel.start} 起 {sel.durDays} 天{sel.override ? '（工期已人工覆盖）' : '（自动推算）'}</div>
            <div><Text type="secondary">报工进度</Text>　{Math.round(sel.progress * 100)}%</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
