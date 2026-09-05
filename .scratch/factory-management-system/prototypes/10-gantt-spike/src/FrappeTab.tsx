import React, { useEffect, useMemo, useRef, useState } from 'react';
import Gantt, { FrappeTask } from 'frappe-gantt';
import { App as AntApp, Button, Modal, Segmented, Space, Typography, Alert } from 'antd';
import { TASKS, SchedTask, barTitle, wcName } from './data';
import dayjs from 'dayjs';
import './frappe-gantt.css';

const { Text } = Typography;

const colorOf = (t: SchedTask) =>
  t.overdue && t.status !== 'done' ? '#ff4d4f' : t.status === 'done' ? '#52c41a' : t.status === 'wip' ? '#faad14' : '#1677ff';

export default function FrappeTab() {
  const { message } = AntApp.useApp();
  const ref = useRef<HTMLDivElement>(null);
  const ganttRef = useRef<Gantt | null>(null);
  const [log, setLog] = useState('（尚未拖拽/点击）');
  const [sel, setSel] = useState<SchedTask | null>(null);
  const [mode, setMode] = useState('Day');

  const tasks = useMemo<FrappeTask[]>(
    () =>
      TASKS.map((t) => ({
        id: t.id,
        name: `${t.ps}·行${t.line} ${t.product}`,
        start: t.start,
        end: dayjs(t.start).add(t.durDays, 'day').format('YYYY-MM-DD'),
        progress: Math.round(t.progress * 100),
        color: colorOf(t),
        color_progress: 'rgba(0,0,0,.22)',
        // 携带域数据供弹窗/回调使用
        _meta: t,
      })),
    [],
  );

  useEffect(() => {
    if (!ref.current || ganttRef.current) return;
    const g = new Gantt(ref.current, tasks, {
      view_mode: 'Day',
      // 注意：fixed_duration:true（只拖开始日）会触发库内 update_handle_position 空引用报错（1.2.2 bug）；
      // 验证结论：保持默认（右缘可拉=工期覆盖的一种入口），工期更精细覆盖走排期面板。
      // fixed_duration: true,
      readonly_progress: true, // 进度由报工驱动，不在此拖
      language: 'en',
      popup: ({ task }) => {
        const m = task._meta as SchedTask;
        if (!m) return false;
        return `<div style="padding:8px 10px;font-size:12px;line-height:1.7">
          <b>${m.ps} 行${m.line}</b> · ${m.product} ×${m.qty}<br/>
          客户：${m.customer}｜工序：${wcName(m.wc)}<br/>
          交期：${m.due}｜进度：${Math.round(m.progress * 100)}%<br/>
          <span style="color:#888">${m.override ? '工期已人工覆盖' : '工期自动推算'}${m.overdue ? '  ⚠超期' : ''}</span></div>`;
      },
      on_click: (task) => {
        const m = task._meta as SchedTask;
        if (m) setSel(m);
      },
      on_date_change: (task, start, end) => {
        const m = task._meta as SchedTask;
        const msg = `任务 ${m.ps}·行${m.line} 开始 ${dayjs(start).format('YYYY-MM-DD')} → ${dayjs(end).format('YYYY-MM-DD')}`;
        setLog(msg);
        message.success(`[frappe] on_date_change：${msg}`);
      },
    });
    ganttRef.current = g;
    return () => {
      ganttRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setView = (v: string) => {
    setMode(v);
    ganttRef.current?.change_view_mode(v);
    setLog(`视图切换 → ${v}`);
  };

  return (
    <div>
      <Alert type="warning" showIcon style={{ marginBottom: 8 }} title="frappe-gantt = 任务树/SVG 甘特：每个任务独占一行，左无表格式列、无「泳道重叠堆叠」概念（同名/同期任务只能纵向分行）。亮点：MIT、零依赖、task.color 逐条配色、拖拽/缩放开关注册回调、日/周/月视图。若选它，I11 需把看板从「6 泳道」改成「任务分行（可按工序归组折叠）」。" />
      <Space style={{ marginBottom: 8 }}>
        <Segmented options={['Day', 'Week', 'Month']} value={mode} onChange={(v) => setView(String(v))} />
        <Button size="small" onClick={() => ganttRef.current?.scroll_current()}>回到今天</Button>
        <Text type="secondary">进度条仅展示（报工驱动，禁止拖动）；条=可拖改开始日</Text>
      </Space>
      <div data-cb-log style={{ fontSize: 12, color: '#0958d9', background: '#f0f5ff', border: '1px dashed #adc6ff', borderRadius: 6, padding: '4px 10px', marginBottom: 8, minHeight: 24 }}>{log}</div>
      <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 8, overflow: 'auto', maxHeight: 640 }}>
        <div ref={ref} />
      </div>
      <Modal open={!!sel} onCancel={() => setSel(null)} footer={null} title={sel ? `行简介：${sel.ps} 行${sel.line}` : ''} width={440}>
        {sel && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><Text type="secondary">产品行</Text>　{sel.product} ×{sel.qty} 只（{wcName(sel.wc)}）</div>
            <div><Text type="secondary">客户</Text>　{sel.customer}</div>
            <div><Text type="secondary">交期</Text>　{sel.due}</div>
            <div><Text type="secondary">进度</Text>　{Math.round(sel.progress * 100)}%（绿=完成 黄=进行中）</div>
            <div><Text type="secondary">提示</Text>　{barTitle(sel)}</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
