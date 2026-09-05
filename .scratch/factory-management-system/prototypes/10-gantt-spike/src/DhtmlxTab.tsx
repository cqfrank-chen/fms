import React, { useEffect, useRef, useState } from 'react';
import { gantt } from 'dhtmlx-gantt';
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css';
import { App as AntApp, Modal, Segmented, Space, Typography, Alert } from 'antd';
import { TASKS, SchedTask, wcName } from './data';
import dayjs from 'dayjs';

const { Text } = Typography;

// dhtmlx-gantt 自带 codebase/dhtmlxgantt.d.ts，类型直接可用
export default function DhtmlxTab() {
  const { message } = AntApp.useApp();
  const ref = useRef<HTMLDivElement>(null);
  const inited = useRef(false);
  const [log, setLog] = useState('（尚未拖拽/点击）');
  const [sel, setSel] = useState<SchedTask | null>(null);
  const [unit, setUnit] = useState<'day' | 'week' | 'month'>('day');

  useEffect(() => {
    if (!ref.current || inited.current) return;
    inited.current = true;
    gantt.config.date_format = '%Y-%m-%d';
    gantt.config.scale_unit = 'day';
    gantt.config.date_scale = '%d %M';
    gantt.config.subscales = [{ unit: 'month', step: 1, date: '%M %Y' }];
    gantt.config.columns = [
      { name: 'text', label: '任务', tree: true, width: 190 },
      { name: 'wc', label: '工序', width: 96, align: 'center', template: (t: any) => wcName(t.wc) },
      { name: 'product', label: '产品', width: 110, template: (t: any) => String(t.product ?? '') },
      { name: 'customer', label: '客户', width: 120, template: (t: any) => String(t.customer ?? '') },
      { name: 'start_date', label: '开始', width: 88, align: 'center' },
      { name: 'duration', label: '天数', width: 56, align: 'center' },
    ];
    gantt.config.drag_move = true;
    gantt.config.drag_resize = false; // 工期由推算/面板覆盖，禁止条上缩放
    gantt.config.drag_progress = false;
    gantt.config.show_progress = true;
    gantt.config.scale_height = 52;
    gantt.config.min_column_width = 46;
    gantt.config.row_height = 38;

    // 按状态/超期给任务条上色
    gantt.templates.task_class = (_s: Date, _e: Date, t: any) => {
      const c: string[] = [];
      if (t.status === 'done') c.push('st-done');
      else if (t.status === 'wip') c.push('st-wip');
      if (t.overdue && t.status !== 'done') c.push('st-overdue');
      if (t.override) c.push('st-override');
      return c.join(' ');
    };
    gantt.templates.tooltip_text = (_s: Date, _e: Date, t: any) =>
      `<b>${t.ps} 行${t.line}</b>｜${t.product} ×${t.qty}<br/>客户 ${t.customer}｜工序 ${wcName(t.wc)}<br/>交期 ${t.due}｜进度 ${Math.round((t.progress || 0) * 100)}%`;

    gantt.init(ref.current);
    const data = TASKS.map((t) => ({
      id: t.id,
      text: `${t.ps}·行${t.line}`,
      start_date: t.start,
      duration: t.durDays,
      progress: t.progress,
      open: true,
      wc: t.wc,
      product: t.product,
      customer: t.customer,
      ps: t.ps,
      line: t.line,
      qty: t.qty,
      due: t.due,
      status: t.status,
      overdue: t.overdue,
      override: t.override,
    }));
    gantt.parse({ data });
    gantt.render();
    gantt.showTask(1); // 滚动定位到首个任务，确保智能渲染可视区内有数据

    gantt.attachEvent('onAfterTaskDrag', (id: number, _mode: string, _e: unknown) => {
      const t: any = gantt.getTask(id);
      const msg = `任务 ${t.ps}·行${t.line} 新开始 ${gantt.templates.date_grid?.(t.start_date) ?? dayjs(t.start_date).format('YYYY-MM-DD')}，工期 ${t.duration} 天`;
      setLog(msg);
      message.success(`[dhtmlx] onAfterTaskDrag：${msg}`);
      return true;
    });
    gantt.attachEvent('onTaskClick', (id: number) => {
      const t: any = gantt.getTask(id);
      setSel({ id, ps: t.ps, line: t.line, product: t.product, customer: t.customer, qty: t.qty, wc: t.wc, start: dayjs(t.start_date).format('YYYY-MM-DD'), durDays: t.duration, status: t.status, progress: t.progress, due: t.due, overdue: t.overdue, override: t.override });
      return true;
    });
    gantt.attachEvent('onScaleClick', () => true);
    return () => {
      /* keep单例：antd Tabs 卸载时清 DOM 即可 */
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoom = (u: 'day' | 'week' | 'month') => {
    setUnit(u);
    gantt.config.scale_unit = u;
    if (u === 'day') { gantt.config.date_scale = '%d %M'; gantt.config.subscales = [{ unit: 'month', step: 1, date: '%M %Y' }]; }
    else if (u === 'week') { gantt.config.date_scale = '周 %W'; gantt.config.subscales = [{ unit: 'month', step: 1, date: '%M %Y' }]; }
    else { gantt.config.date_scale = '%M'; gantt.config.subscales = [{ unit: 'year', step: 1, date: '%Y' }]; }
    gantt.render();
    setLog(`时间轴切换 → ${u === 'day' ? '日' : u === 'week' ? '周' : '月'}`);
  };

  return (
    <div>
      <Alert type="warning" showIcon style={{ marginBottom: 8 }} title="dhtmlx-gantt v10 = MIT 社区版，能力最强的任务树甘特（列/模板/事件/缩放均齐），但同样「每任务一行」：无固定泳道、无同泳道重叠堆叠；工序只能作为分组父行折叠。选它则 I11 看板同样要改成任务分行结构（表格左列可放单号/产品/客户，信息展示强）。" />
      <Space style={{ marginBottom: 8 }}>
        <Segmented options={[{ label: '日', value: 'day' }, { label: '周', value: 'week' }, { label: '月', value: 'month' }]} value={unit} onChange={(v) => zoom(v as 'day' | 'week' | 'month')} />
        <Text type="secondary">条=可拖动改开始日；悬停出气泡；点行弹出详情</Text>
      </Space>
      <div data-cb-log style={{ fontSize: 12, color: '#0958d9', background: '#f0f5ff', border: '1px dashed #adc6ff', borderRadius: 6, padding: '4px 10px', marginBottom: 8, minHeight: 24 }}>{log}</div>
      <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 8, overflow: 'auto', minHeight: 560 }}>
        <div ref={ref} style={{ minHeight: 520 }} />
      </div>
      <Modal open={!!sel} onCancel={() => setSel(null)} footer={null} title={sel ? `行简介：${sel.ps} 行${sel.line}` : ''} width={440}>
        {sel && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><Text type="secondary">产品行</Text>　{sel.product} ×{sel.qty} 只（{wcName(sel.wc)}）</div>
            <div><Text type="secondary">客户</Text>　{sel.customer}</div>
            <div><Text type="secondary">排程</Text>　{sel.start} 起 {sel.durDays} 天{sel.override ? '（覆盖）' : ''}</div>
            <div><Text type="secondary">交期</Text>　{sel.due} {sel.overdue ? '⚠超期' : ''}</div>
            <div><Text type="secondary">进度</Text>　{Math.round(sel.progress * 100)}%</div>
          </div>
        )}
      </Modal>
      <style>{`
        .gantt_task_line.st-done { background:#52c41a; border-color:#389e0d; }
        .gantt_task_line.st-wip { background:#faad14; border-color:#d48806; }
        .gantt_task_line.st-done .gantt_task_progress { background:#237804; }
        .gantt_task_line.st-wip .gantt_task_progress { background:#ad6800; }
        .gantt_task_line.st-overdue { box-shadow:0 0 0 2px #ff4d4f; }
        .gantt_task_line.st-override { border-style:dashed; }
      `}</style>
    </div>
  );
}
