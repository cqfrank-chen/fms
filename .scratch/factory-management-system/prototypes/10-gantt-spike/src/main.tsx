import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, Tabs, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import FrappeTab from './FrappeTab';
import DhtmlxTab from './DhtmlxTab';
import LaneTab from './LaneTab';

const SpikeApp = () => {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <div className="spike-head">
          <h2 style={{ margin: '6px 0 2px' }}>I10 · 甘特库技术验证</h2>
          <div className="spike-sub">
            演示数据：模拟 12 条"计划单行排期任务"（6 工序泳道、交期/超期/覆盖/报工进度）。三个 Tab = 候选库横向实测 + 泳道目标形态。
          </div>
        </div>
        <Tabs
          defaultActiveKey="lane"
          style={{ padding: '0 8px' }}
          items={[
            {
              key: 'lane',
              label: '目标形态：6 工序泳道（自研参考）',
              children: <LaneTab />,
            },
            {
              key: 'frappe',
              label: '候选①：frappe-gantt (MIT)',
              children: <FrappeTab />,
            },
            {
              key: 'dhtmlx',
              label: '候选②：dhtmlx-gantt v10 (MIT)',
              children: <DhtmlxTab />,
            },
          ]}
        />
      </AntApp>
    </ConfigProvider>
  );
};

createRoot(document.getElementById('root')!).render(<SpikeApp />);
