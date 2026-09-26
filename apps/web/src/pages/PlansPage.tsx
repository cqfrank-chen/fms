import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Descriptions, Empty, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { CURRENCY_LABEL, PACK_LABEL, STATUS_LABEL } from '../lib/labels'
import type { Customer, Order, OrderLine, PlanSheet } from '../lib/types'

const { Text } = Typography

const statusColor = (v: string) =>
  v === 'completed' ? 'success' : v === 'draft' ? 'default' : v === 'cancelled' || v === 'voided' ? 'error' : 'processing'

/** 计划单五态筛选白名单（计划单无 cancelled，订单无 voided，勿共用 STATUS_LABEL 全表） */
const PLAN_FILTER = ['draft', 'confirmed', 'production', 'completed', 'voided']

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
  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [reportPlan, setReportPlan] = useState<PlanSheet | null>(null)
  const [reportLineId, setReportLineId] = useState<number>()
  const [reportQty, setReportQty] = useState<number | null>(null)
  const [reporting, setReporting] = useState(false)
  const [traceOrder, setTraceOrder] = useState<Order | null>(null)

  async function openTrace(orderId: number) {
    try {
      setTraceOrder(await api<Order>(`/orders/${orderId}`))
    } catch (e) {
      message.error('来源订单反查失败：' + (e as Error).message)
    }
  }

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
      message.success(`计划单 ${updated.planNo} 已审核，进入生产池（可到排程看板排期）`)
      fetchRows()
    } catch (e) {
      message.error('审核失败：' + (e as Error).message)
    } finally { setAuditingId(null) }
  }

  /** 审核不通过：计划单作废 + 订单退回草稿（订单列表可编辑后重新确认） */
  async function doReject(r: PlanSheet) {
    setRejectingId(r.id)
    try {
      const updated = await api<PlanSheet>(`/plan-sheets/${r.id}/reject`, { method: 'POST' })
      message.success(`已驳回：计划单 ${updated.planNo} 作废；订单 ${updated.orderNo} 退回草稿，可到「订单列表」编辑后重新确认`)
      fetchRows()
    } catch (e) {
      message.error('驳回失败：' + (e as Error).message)
    } finally { setRejectingId(null) }
  }

  function openReport(r: PlanSheet) {
    setReportPlan(r)
    setReportLineId(undefined)
    setReportQty(null)
  }

  /** 选中报工行：带入当前工序应报数（整批逐道：中间道=整批；末道/无路由=剩余） */
  function pickReportLine(id: number) {
    setReportLineId(id)
    const line = reportPlan?.lines.find((l) => l.id === id)
    setReportQty(line && line.requiredQty != null ? line.requiredQty : null)
  }

  async function doReport() {
    if (!reportPlan || !reportLineId || reportQty == null) {
      message.warning('请选择产品行并填写本次完成数量')
      return
    }
    // 带上页面展示的当前状态：服务端据此做乐观校验，重复提交不会重复累计/跨工序推进
    const snapshot = reportPlan.lines.find((l) => l.id === reportLineId)
    setReporting(true)
    try {
      const updated = await api<PlanSheet>(`/plan-sheets/${reportPlan.id}/report`, {
        method: 'POST',
        body: {
          lineId: reportLineId,
          doneQty: reportQty,
          routeSeq: snapshot?.routeSeq,
          completedQuantity: snapshot?.completedQuantity,
        },
      })
      const line = updated.lines.find((l) => l.id === reportLineId)
      if (line && (line.routeTotal ?? 0) > 0) {
        message.success(line.finished
          ? `报工成功：「${line.currentStepName}」末道完成 → 成品 ${line.completedQuantity ?? 0} 只，计划单已完成，入库草稿已生成（待仓管在仓储页确认）`
          : `报工成功：「${line.currentStepName}」（${line.routeSeq}/${line.routeTotal}）完成，已推进到下一道工序`)
      } else {
        message.success('报工成功：完成数量已累计，入库草稿已生成（待仓管在仓储页确认）')
      }
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
          {r.lines?.map((l, i) => {
            const done = l.completedQuantity ?? 0
            const tot = l.routeTotal ?? 0
            const stepDone = tot > 0 && !(done >= l.quantity)
            return (
              <div key={i} style={{ fontSize: 12 }}>
                {done >= l.quantity ? '✅' : done > 0 ? '🔄' : ''} {l.productName} × {l.quantity}
                {done > 0 && <Text type={done >= l.quantity ? 'success' : undefined}>（成品 {done}/{l.quantity}）</Text>}
                {stepDone && <Text type="warning" style={{ fontSize: 12 }}> 🔧{l.currentStepName}（{Math.min(l.routeSeq ?? 1, tot)}/{tot}）</Text>}
                {l.engraving ? ` ✒${l.engraving}` : ''}
              </div>
            )
          })}
        </Space>
      ),
    },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => <Tag color={statusColor(v)}>{STATUS_LABEL[v] ?? v}</Tag>,
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('YYYY-MM-DD HH:mm')}</Text> : '—') },
    {
      title: '操作', width: 250,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'draft' && (
            <>
              <Popconfirm
                title="审核不通过？"
                description={`计划单 ${r.planNo} 将作废，订单 ${r.orderNo} 退回草稿（可到订单列表编辑后重新确认，生成新计划单）`}
                okText="驳回" okButtonProps={{ danger: true }} cancelText="取消"
                onConfirm={() => doReject(r)}
              >
                <Button danger size="small" loading={rejectingId === r.id}>不通过</Button>
              </Popconfirm>
              <Button type="primary" size="small" loading={auditingId === r.id} onClick={() => doAudit(r)}>审核</Button>
            </>
          )}
          {(r.status === 'confirmed' || r.status === 'production') && (
            <Button type="primary" size="small" ghost onClick={() => openReport(r)}>报工</Button>
          )}
          <Button size="small" onClick={() => setDetail(r)}>详情</Button>
        </Space>
      ),
    },
  ], [auditingId, rejectingId])

  const filterBar = (
    <Space wrap style={{ marginBottom: 12 }}>
      <Select style={{ width: 130 }} value={status} onChange={setStatus} placeholder="全部状态"
        options={PLAN_FILTER.map((value) => ({ value, label: STATUS_LABEL[value] ?? value }))} allowClear />
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
        locale={{ emptyText: <Empty description="暂无计划单 —— 在订单列表点「确认」后自动生成" /> }} />
      {detail && <PlanDetail plan={detail} onClose={() => setDetail(null)} onTrace={() => openTrace(detail.orderId)} />
      }
      {traceOrder && <OrderTraceModal order={traceOrder} onClose={() => setTraceOrder(null)} />}
      <Modal
        title={`行报工 ${reportPlan?.planNo ?? ''}`}
        open={!!reportPlan} onCancel={() => setReportPlan(null)}
        onOk={doReport} confirmLoading={reporting} okText="提交报工" width={620}
      >
        {reportPlan && (() => {
          const reportLine = reportPlan.lines.find((l) => l.id === reportLineId)
          const tot = reportLine?.routeTotal ?? 0
          const seq = Math.min(reportLine?.routeSeq ?? 1, Math.max(1, tot))
          const hasRoute = tot > 0
          const isLast = hasRoute && seq >= tot
          return (
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              <div>
                <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
                  选择产品行（办公室 PC 代录；配了工序路线的产品按「当前工序」整批逐道推进）
                </Typography.Text>
                <Select
                  style={{ width: '100%' }} value={reportLineId} onChange={pickReportLine} placeholder="选择产品行"
                  options={reportPlan.lines
                    ?.filter((l) => (l.completedQuantity ?? 0) < l.quantity && !l.finished)
                    .map((l) => ({
                      value: l.id,
                      label: (l.routeTotal ?? 0) > 0
                        ? `${l.productName} × ${l.quantity} ｜工序 ${l.currentStepName}（${Math.min(l.routeSeq ?? 1, l.routeTotal!)}/${l.routeTotal}）`
                        : `${l.productName} × ${l.quantity}（成品直报，剩余 ${l.requiredQty}）`,
                    }))}
                />
              </div>
              {reportLine && hasRoute && (
                <Alert
                  type="info" showIcon style={{ marginBottom: 0 }}
                  message={isLast
                    ? `末道工序「${reportLine.currentStepName}」：报满 ${reportLine.requiredQty} 只 → 成品完成（${reportLine.completedQuantity ?? 0}/${reportLine.quantity}）→ 计划单/订单完成 + 入库草稿`
                    : `当前工序「${reportLine.currentStepName}」（${seq}/${tot}）：整批 ${reportLine.requiredQty} 只一次报完 → 自动推进到下一道，排程随之前进`}
                />
              )}
              {reportLine && !hasRoute && (
                <Alert
                  type="warning" showIcon style={{ marginBottom: 0 }}
                  message="该产品未配置工序路线 → 按成品直接报工（可分批，每次 ≤ 剩余数量）。建议到「设置 → 产品工序」为它补齐工序链，报工将按工种逐道推进。"
                />
              )}
              <div>
                <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
                  本次完成数量{hasRoute ? '（整批固定）' : ''}
                </Typography.Text>
                <InputNumber style={{ width: '100%' }} min={1}
                  max={reportLine?.requiredQty} disabled={hasRoute}
                  value={reportQty} onChange={(v) => setReportQty(v as number | null)}
                  placeholder={hasRoute ? '整批一次报完' : '≥ 1'} />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {hasRoute
                  ? '提示：中间工序报工不产成品、不触发入库；全部工序走完（末道）才累计成品并生成入库草稿（批次号自动生成，待仓管确认入库）。'
                  : '提示：报工累计成品并推进计划单/订单状态；同时生成入库单草稿（批次号自动生成，待仓管确认入库）。'}
              </Typography.Text>
            </Space>
          )
        })()}
      </Modal>
    </Card>
  )
}

/** 计划单详情：单头（含来源订单信息）+ 行（可反查订单行） */
function PlanDetail({ plan, onClose, onTrace }: { plan: PlanSheet; onClose: () => void; onTrace: () => void }) {
  return (
    <Modal
      title={`计划单详情 ${plan.planNo}`}
      open onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onTrace}>反查来源订单</Button>
          <Button type="primary" onClick={onClose}>关闭</Button>
        </Space>
      }
      width={820}
    >
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
          { title: '成品', dataIndex: 'completedQuantity', width: 90, render: (v?: number) => v ?? 0 },
          {
            title: '工序进度', width: 190,
            render: (_, l) => {
              const ll = l as unknown as { routeTotal?: number; routeSeq?: number; currentStepName?: string | null; finished?: boolean }
              if (ll.finished || (l as unknown as { completedQuantity?: number; quantity?: number }).completedQuantity! >= (l as unknown as { quantity?: number }).quantity!) return '✅ 全部完成'
              return (ll.routeTotal ?? 0) > 0
                ? `🔧${ll.currentStepName}（${Math.min(ll.routeSeq ?? 1, ll.routeTotal!)}/${ll.routeTotal}）`
                : '—（未配路由·成品直报）'
            },
          },
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

/** 来源订单反查：完整订单详情（单头+行：单价/币种/金额/刻字/包装） */
function OrderTraceModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const total = order.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  return (
    <Modal title={`来源订单 ${order.orderNo}`} open onCancel={onClose} footer={<Button type="primary" onClick={onClose}>关闭</Button>} width={860}>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="状态"><Tag color={statusColor(order.status)}>{STATUS_LABEL[order.status] ?? order.status}</Tag></Descriptions.Item>
        <Descriptions.Item label="客户">{order.customerName || '—'}</Descriptions.Item>
        <Descriptions.Item label="PO号">{order.poNo || '—'}</Descriptions.Item>
        <Descriptions.Item label="交期">{dayjs(order.dueDate).format('YYYY-MM-DD')}</Descriptions.Item>
        <Descriptions.Item label="下单时间">{dayjs(order.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
        <Descriptions.Item label="订单金额">{total.toLocaleString()} {CURRENCY_LABEL[order.lines[0]?.currency ?? ''] ?? ''}</Descriptions.Item>
        <Descriptions.Item label="备注" span={3}>{order.note || '—'}</Descriptions.Item>
      </Descriptions>
      <Table<OrderLine>
        rowKey={(l) => String(l.id)}
        size="small" bordered pagination={false} dataSource={order.lines}
        columns={[
          { title: '产品', dataIndex: 'productName' },
          { title: '数量', dataIndex: 'quantity', width: 90 },
          { title: '单价', width: 110, render: (_, l) => `${l.unitPrice} ${CURRENCY_LABEL[l.currency] ?? l.currency}` },
          { title: '小计', width: 120, render: (_, l) => (l.quantity * l.unitPrice).toLocaleString() },
          { title: '刻字', dataIndex: 'engraving', width: 130, render: (v?: string | null) => (v ? `✒${v}` : '—') },
          { title: '包装要求', width: 200, render: (_, l) => {
            const pack = (l.packaging ?? {}) as Record<string, string>
            const txt = Object.entries(pack).map(([k, v]) => `${PACK_LABEL[k] ?? k}:${v}`).join('；')
            return <span style={{ fontSize: 12 }}>{txt || '—'}</span>
          } },
        ]}
      />
    </Modal>
  )
}

export default PlansPage
