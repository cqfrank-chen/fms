import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Descriptions, Empty, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { PACK_LABEL, STATUS_LABEL } from '../lib/labels'
import type { Customer, OrderLine, PlanSheet } from '../lib/types'

const { Text } = Typography

const statusColor = (v: string) =>
  v === 'completed' ? 'success' : v === 'draft' ? 'default' : v === 'cancelled' ? 'error' : 'processing'

/**
 * 计划单页（I05）：订单确认自动生成的草稿 → 计划员审核
 * 列表三筛选（状态/客户/关键字）+ 来源订单反查弹窗
 */
function PlansPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [rows, setRows] = useState<PlanSheet[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [customerId, setCustomerId] = useState<number | undefined>()
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<PlanSheet | null>(null)
  const [auditingId, setAuditingId] = useState<number | null>(null)
  const [reportPlan, setReportPlan] = useState<PlanSheet | null>(null)
  const [reportLineId, setReportLineId] = useState<number>()
  const [reportQty, setReportQty] = useState<number | null>(null)
  const [reporting, setReporting] = useState(false)

  useEffect(() => { api<Customer[]>('/customers').then(setCustomers).catch(() => {}) }, [])

  async function fetchRows() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (customerId) params.set('customerId', String(customerId))
      if (kw.trim()) params.set('kw', kw.trim())
      setRows(await api<PlanSheet[]>(`/plan-sheets?${params.toString()}`))
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally { setLoading(false) }
  }
  useEffect(() => { fetchRows() }, [status, customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doAudit(r: PlanSheet) {
    setAuditingId(r.id)
    try {
      const updated = await api<PlanSheet>(`/plan-sheets/${r.id}/audit`, { method: 'POST' })
      message.success(`计划单 ${updated.planNo} 已审核，进入生产池（排期 I11）`)
      fetchRows()
    } catch (e) {
      message.error('审核失败：' + (e as Error).message)
    } finally { setAuditingId(null) }
  }

  function openReport(r: PlanSheet) {
    setReportPlan(r)
    setReportLineId(undefined)
    setReportQty(null)
  }

  async function doReport() {
    if (!reportPlan || !reportLineId || reportQty == null) {
      message.warning('请选择产品行并填写本次完成数量')
      return
    }
    setReporting(true)
    try {
      await api(`/plan-sheets/${reportPlan.id}/report`, { method: 'POST', body: { lineId: reportLineId, doneQty: reportQty } })
      message.success('报工成功：完成数量已累计，入库草稿已生成（仓管确认 I08）')
      setReportPlan(null)
      fetchRows()
    } catch (e) {
      message.error('报工失败：' + (e as Error).message)
    } finally { setReporting(false) }
  }

  const columns: ColumnsType<PlanSheet> = useMemo(() => [
    { title: '计划单号', dataIndex: 'planNo', width: 170, render: (v: string) => <Text strong>{v}</Text> },
    {
      title: '来源订单', width: 190, render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Text>{r.orderNo}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.poNo ? `PO ${r.poNo}` : ''}</Text>
        </Space>
      ),
    },
    { title: '客户', dataIndex: 'customerName', width: 160, render: (v?: string | null) => v || '—' },
    { title: '交期', dataIndex: 'dueDate', width: 110, render: (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '—') },
    {
      title: '产品行', render: (_, r) => (
        <Space direction="vertical" size={2}>
          {r.lines?.map((l, i) => (
            <div key={i} style={{ fontSize: 12 }}>
              {l.productName} × {l.quantity}
              {(l.completedQuantity ?? 0) > 0 && <Text type="success">（完成 {l.completedQuantity}/{l.quantity}）</Text>}
              {l.engraving ? ` ✒${l.engraving}` : ''}
            </div>
          ))}
        </Space>
      ),
    },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => <Tag color={statusColor(v)}>{STATUS_LABEL[v] ?? v}</Tag>,
    },
    {
      title: '操作', width: 210,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'draft' && (
            <Button type="primary" size="small" loading={auditingId === r.id} onClick={() => doAudit(r)}>审核</Button>
          )}
          {(r.status === 'confirmed' || r.status === 'production') && (
            <Button type="primary" size="small" ghost onClick={() => openReport(r)}>报工</Button>
          )}
          <Button size="small" onClick={() => setDetail(r)}>详情</Button>
        </Space>
      ),
    },
  ], [auditingId])

  const filterBar = (
    <Space wrap style={{ marginBottom: 12 }}>
      <Select style={{ width: 130 }} value={status} onChange={setStatus} placeholder="全部状态"
        options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} allowClear />
      <Select style={{ width: 180 }} value={customerId} onChange={setCustomerId} placeholder="全部客户"
        options={customers.map((c) => ({ value: c.id, label: c.name }))} allowClear />
      <Input.Search placeholder="计划单号搜索" style={{ width: 200 }} allowClear
        onSearch={(v) => { setKw(v); fetchRows() }} />
    </Space>
  )

  return (
    <Card title="计划单" size="small">
      {filterBar}
      <Table<PlanSheet> rowKey="id" loading={loading} size="small" columns={columns} dataSource={rows}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description="暂无计划单 —— 订单列表点「确认」自动生成草稿（I05）" /> }} />
      {detail && <PlanDetail plan={detail} onClose={() => setDetail(null)} />}
      <Modal
        title={`行报工 ${reportPlan?.planNo ?? ''}`}
        open={!!reportPlan} onCancel={() => setReportPlan(null)}
        onOk={doReport} confirmLoading={reporting} okText="提交报工" width={540}
      >
        {reportPlan && (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <div>
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
                选择产品行（办公室 PC 代录，按纸单填本次完成数量）
              </Typography.Text>
              <Select
                style={{ width: '100%' }} value={reportLineId} onChange={setReportLineId} placeholder="选择产品行"
                options={reportPlan.lines
                  ?.filter((l) => (l.completedQuantity ?? 0) < l.quantity)
                  .map((l) => ({
                    value: l.id,
                    label: `${l.productName} × ${l.quantity}（已完成 ${l.completedQuantity ?? 0}，可报 ${l.quantity - (l.completedQuantity ?? 0)}）`,
                  }))}
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>本次完成数量</Typography.Text>
              <InputNumber style={{ width: '100%' }} min={1} value={reportQty}
                onChange={(v) => setReportQty(v as number | null)} placeholder="≥ 1" />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              提示：报工自动累计完成量并推进计划单/订单状态；同时生成入库单草稿（批次 FG-YYYYMMDD-NN，仓管确认在 I08）。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </Card>
  )
}

/** 计划单详情：单头（含来源订单信息）+ 行（可反查订单行） */
function PlanDetail({ plan, onClose }: { plan: PlanSheet; onClose: () => void }) {
  return (
    <Modal title={`计划单详情 ${plan.planNo}`} open onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={820}>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="状态"><Tag color={statusColor(plan.status)}>{STATUS_LABEL[plan.status]}</Tag></Descriptions.Item>
        <Descriptions.Item label="来源订单">{plan.orderNo}</Descriptions.Item>
        <Descriptions.Item label="客户">{plan.customerName || '—'}</Descriptions.Item>
        <Descriptions.Item label="PO号">{plan.poNo || '—'}</Descriptions.Item>
        <Descriptions.Item label="交期">{plan.dueDate ? dayjs(plan.dueDate).format('YYYY-MM-DD') : '—'}</Descriptions.Item>
        <Descriptions.Item label="订单状态">{plan.orderStatus ? STATUS_LABEL[plan.orderStatus] : '—'}</Descriptions.Item>
        <Descriptions.Item label="订单备注" span={3}>{plan.note || '—'}</Descriptions.Item>
      </Descriptions>
      <Table<OrderLine>
        rowKey={(l) => String(l.id)}
        size="small" bordered pagination={false}
        dataSource={plan.lines as unknown as OrderLine[]}
        columns={[
          { title: '产品', dataIndex: 'productName' },
          { title: '数量', dataIndex: 'quantity', width: 80 },
          { title: '已完成', dataIndex: 'completedQuantity', width: 80, render: (v?: number) => v ?? 0 },
          { title: '刻字', dataIndex: 'engraving', width: 140, render: (v?: string | null) => (v ? `✒${v}` : '—') },
          { title: '包装要求', width: 220, render: (_, l) => {
            const pack = (l as unknown as { packaging?: Record<string, string> }).packaging ?? {}
            const txt = Object.entries(pack).map(([k, v]) => `${PACK_LABEL[k] ?? k}:${v}`).join('；')
            return <span style={{ fontSize: 12 }}>{txt || '—'}</span>
          } },
        ]}
      />
    </Modal>
  )
}

export default PlansPage
