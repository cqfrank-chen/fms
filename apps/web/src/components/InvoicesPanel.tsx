import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Collapse, DatePicker, Descriptions, Empty, Input, Modal,
  Row, Select, Space, Statistic, Switch, Table, Tag, Tabs, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { api, loadOptions } from '../lib/api'
import { INVOICE_PLACEHOLDER_PREFIX, INVOICE_STATUS_LABEL, INVOICE_TYPE_LABEL, STATUS_LABEL } from '../lib/labels'
import { fmtCents, fromCents, rateLabel } from '../lib/money'
import type {
  Customer, Invoice, InvoicePage, InvoiceStatus, InvoiceSummary, InvoiceType, Order, OrderInvoiceStatus,
} from '../lib/types'
import InvoiceFormModal from './InvoiceFormModal'

const { Text } = Typography
const { RangePicker } = DatePicker

type RangeValue = [Dayjs | null, Dayjs | null] | null

const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** 票号展示：占位号（待补号-…）标记为「待补票号」，可编辑时补录真实票号 */
function InvoiceNoText({ invoiceNo, status }: { invoiceNo: string; status: InvoiceStatus }) {
  const placeholder = invoiceNo.startsWith(INVOICE_PLACEHOLDER_PREFIX)
  if (status === 'voided') return <Text delete type="secondary">{invoiceNo}</Text>
  return (
    <Space size={4}>
      <Text strong={!placeholder} type={placeholder ? 'secondary' : undefined}>{invoiceNo}</Text>
      {placeholder && <Tag color="warning">待补票号</Tag>}
    </Space>
  )
}

/**
 * 开票记录区块（I16，交互简化版）
 * ------------------------------------------------------------------
 * 主路径只有三件事：**开票（关联订单 + 一个金额）** / **列表** / **作废**。
 * 统计卡、按客户/按月小计、订单对账、票种/税率/税额等明细收进「高级」折叠区（默认收起，能力不删除）。
 */
export default function InvoicesPanel() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [range, setRange] = useState<RangeValue>([dayjs().startOf('month'), dayjs().endOf('month')])
  const [status, setStatus] = useState<InvoiceStatus | undefined>()
  const [customerId, setCustomerId] = useState<number | undefined>()
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [data, setData] = useState<InvoicePage>({ items: [], total: 0, page: 1, pageSize: 10 })
  const [summary, setSummary] = useState<InvoiceSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [showDetailCols, setShowDetailCols] = useState(false)
  const [modal, setModal] = useState<{ open: boolean; edit: Invoice | null }>({ open: false, edit: null })
  const [voiding, setVoiding] = useState<Invoice | null>(null)
  const [voidReason, setVoidReason] = useState('作废重开')
  const [voidSaving, setVoidSaving] = useState(false)
  const [focusOrderId, setFocusOrderId] = useState<number | undefined>()
  const [orderStatus, setOrderStatus] = useState<OrderInvoiceStatus | null>(null)
  const [orderLoading, setOrderLoading] = useState(false)

  useEffect(() => {
    loadOptions<Customer>('/customers', setCustomers, '客户档案')
    loadOptions<Order>('/orders', setOrders, '订单列表')
  }, [])

  const rangeParams = useMemo(() => {
    const p = new URLSearchParams()
    if (isYmd(range?.[0]?.format('YYYY-MM-DD'))) p.set('from', range![0]!.format('YYYY-MM-DD'))
    if (isYmd(range?.[1]?.format('YYYY-MM-DD'))) p.set('to', range![1]!.format('YYYY-MM-DD'))
    return p
  }, [range])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams(rangeParams)
      p.set('page', String(page))
      p.set('pageSize', String(pageSize))
      if (customerId) p.set('customerId', String(customerId))
      if (status) p.set('status', status)
      if (keyword.trim()) p.set('keyword', keyword.trim())
      const [list, sum] = await Promise.all([
        api<InvoicePage>('/invoices?' + p.toString()),
        api<InvoiceSummary>('/invoices/summary?' + rangeParams.toString()),
      ])
      setData(list)
      setSummary(sum)
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally { setLoading(false) }
  }, [rangeParams, page, pageSize, customerId, status, keyword])

  useEffect(() => { load() }, [load])

  async function openOrderStatus(orderId: number) {
    setFocusOrderId(orderId)
    setOrderLoading(true)
    try {
      setOrderStatus(await api<OrderInvoiceStatus>(`/invoices/order-status?orderId=${orderId}`))
    } catch (e) {
      message.error('订单开票进度加载失败：' + (e as Error).message)
    } finally { setOrderLoading(false) }
  }

  async function doVoid() {
    if (!voiding) return
    if (!voidReason.trim()) { message.warning('请填写作废原因'); return }
    setVoidSaving(true)
    try {
      await api(`/invoices/${voiding.id}/void`, { method: 'POST', body: { reason: voidReason.trim() } })
      message.success(`发票 ${voiding.invoiceNo} 已作废（记录保留可查，不再计入统计）`)
      setVoiding(null); setVoidReason('作废重开')
      await load()
      if (focusOrderId) await openOrderStatus(focusOrderId)
    } catch (e) {
      message.error((e as Error).message)
    } finally { setVoidSaving(false) }
  }

  /** 主列（看懂开票所需的全部）：票号 / 客户 / 开票金额 / 日期 / 关联订单 / 状态 / 备注 / 操作 */
  const baseColumns: ColumnsType<Invoice> = [
    { title: '发票号码', dataIndex: 'invoiceNo', width: 190, render: (v: string, r) => <InvoiceNoText invoiceNo={v} status={r.status} /> },
    { title: '客户', dataIndex: 'customerName', width: 140, ellipsis: true },
    { title: '开票金额(元)', dataIndex: 'amountInclCents', width: 130, align: 'right', render: (v: number, r) => (
      r.status === 'voided' ? <Text type="secondary" delete>{fmtCents(v)}</Text> : <Text strong>{fmtCents(v)}</Text>
    ) },
    { title: '开票日期', dataIndex: 'issueDate', width: 110 },
    {
      title: '关联订单', width: 190,
      render: (_, r) => (r.orderNos?.length
        ? (
          <Space size={4} wrap>
            {r.orderRefs.map((o) => (
              <Tag key={o.orderId} color="geekblue" style={{ cursor: 'pointer' }} onClick={() => openOrderStatus(o.orderId)}>
                {o.orderNo}
              </Tag>
            ))}
          </Space>
        )
        : <Text type="secondary" style={{ fontSize: 12 }}>未关联订单</Text>),
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: InvoiceStatus) => (v === 'normal' ? <Tag color="success">正常</Tag> : <Tag color="error">已作废</Tag>) },
    { title: '备注', dataIndex: 'remark', width: 140, ellipsis: true, render: (v?: string | null) => v || '—' },
    {
      title: '操作', width: 130, fixed: 'right',
      render: (_, r) => (r.status === 'normal'
        ? (
          <Space size={4}>
            <Button size="small" onClick={() => setModal({ open: true, edit: r })}>编辑</Button>
            <Button size="small" danger onClick={() => { setVoiding(r); setVoidReason('作废重开') }}>作废</Button>
          </Space>
        )
        : <Text type="secondary" style={{ fontSize: 12 }}>{r.voidReason ? `作废：${r.voidReason}` : '已作废'}</Text>),
    },
  ]

  /** 明细列（默认隐藏，开关打开后展示；能力保留） */
  const detailColumns: ColumnsType<Invoice> = [
    { title: '票种', dataIndex: 'invoiceType', width: 130, render: (v: InvoiceType) => <Tag color="blue">{INVOICE_TYPE_LABEL[v] ?? v}</Tag> },
    { title: '税率', dataIndex: 'taxRate', width: 80, render: (v: number) => rateLabel(Number(v)) },
    { title: '不含税(元)', dataIndex: 'amountExclCents', width: 120, align: 'right', render: (v: number) => fmtCents(v) },
    { title: '税额(元)', dataIndex: 'taxCents', width: 110, align: 'right', render: (v: number) => fmtCents(v) },
    { title: '经办人', dataIndex: 'operatorName', width: 90, render: (v?: string | null) => v || <Text type="secondary">未绑定</Text> },
  ]

  const columns: ColumnsType<Invoice> = useMemo(() => {
    if (!showDetailCols) return baseColumns
    const out = [...baseColumns]
    out.splice(4, 0, ...detailColumns) // 明细列插在「开票日期」之后
    return out
  }, [showDetailCols, baseColumns]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = [
    { label: '开票张数', value: summary?.count ?? 0, suffix: '张', money: false },
    { label: '开票金额（含税）', value: fromCents(summary?.amountInclCents ?? 0), suffix: '元', money: true },
    { label: '不含税合计', value: fromCents(summary?.amountExclCents ?? 0), suffix: '元', money: true },
    { label: '税额合计', value: fromCents(summary?.taxCents ?? 0), suffix: '元', money: true },
  ]

  return (
    <div>
      <Card size="small" title="开票记录">
        <Space size={8} wrap style={{ marginBottom: 12 }}>
          <Button type="primary" onClick={() => setModal({ open: true, edit: null })}>+ 开票</Button>
          <RangePicker
            size="small" value={range as never} allowEmpty={[true, true]}
            onChange={(v) => { setRange(v as RangeValue); setPage(1) }}
            presets={[
              { label: '本月', value: [dayjs().startOf('month'), dayjs().endOf('month')] },
              { label: '上月', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
              { label: '本年', value: [dayjs().startOf('year'), dayjs().endOf('year')] },
            ]}
          />
          <Select size="small" style={{ width: 170 }} allowClear showSearch optionFilterProp="label"
            placeholder="按客户筛选" value={customerId} onChange={(v) => { setCustomerId(v as number); setPage(1) }}
            options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          <Select size="small" style={{ width: 120 }} allowClear placeholder="按状态筛选"
            value={status} onChange={(v) => { setStatus(v as InvoiceStatus); setPage(1) }}
            options={Object.entries(INVOICE_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
          <Input.Search size="small" style={{ width: 200 }} allowClear placeholder="票号/客户/订单号/备注"
            onSearch={(v) => { setKeyword(v); setPage(1) }} />
          <Button size="small" onClick={() => load()}>刷新</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {data.total} 张（含已作废）｜本期开票 {summary?.count ?? 0} 张 / {fmtCents(summary?.amountInclCents ?? 0)} 元
          </Text>
        </Space>

        <Table<Invoice> rowKey="id" size="small" loading={loading} columns={columns} dataSource={data.items}
          scroll={{ x: showDetailCols ? 1560 : 1180 }}
          pagination={{
            current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: true,
            showTotal: (t) => `共 ${t} 张`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          locale={{ emptyText: <Empty description="该筛选条件下暂无开票记录 —— 点击「+ 开票」登记" /> }} />

        <Collapse
          size="small" ghost style={{ marginTop: 8 }}
          items={[{
            key: 'adv',
            label: '高级：统计与明细（本期张数/金额/税额 · 按客户/按月小计 · 订单对账 · 明细列开关）',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Space size={8} wrap>
                  <Switch size="small" checked={showDetailCols} onChange={setShowDetailCols} />
                  <Text type="secondary" style={{ fontSize: 12 }}>在列表中显示票种 / 税率 / 不含税 / 税额 / 经办人（默认隐藏）</Text>
                </Space>

                <Row gutter={[12, 12]}>
                  {stats.map((s) => (
                    <Col span={6} key={s.label}>
                      <Card size="small">
                        <Statistic title={s.label} value={s.value} precision={s.money ? 2 : 0} suffix={s.suffix} />
                      </Card>
                    </Col>
                  ))}
                </Row>

                <Card size="small" title="开票小计（按客户 / 按月）"
                  extra={<Text type="secondary" style={{ fontSize: 12 }}>
                    {summary?.from || summary?.to ? `区间：${summary?.from ?? '不限'} ~ ${summary?.to ?? '不限'}` : '区间：全部'}
                  </Text>}>
                  <Tabs size="small" items={[
                    {
                      key: 'customer', label: '按客户',
                      children: (
                        <Table<InvoiceSummary['byCustomer'][number]> rowKey="customerId" size="small" pagination={false}
                          dataSource={summary?.byCustomer ?? []}
                          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该区间暂无开票记录" /> }}
                          columns={[
                            { title: '客户', dataIndex: 'customerName', render: (v: string) => v || '—' },
                            { title: '张数', dataIndex: 'count', width: 90, align: 'right' },
                            { title: '不含税(元)', dataIndex: 'amountExclCents', width: 130, align: 'right', render: (v: number) => fmtCents(v) },
                            { title: '税额(元)', dataIndex: 'taxCents', width: 120, align: 'right', render: (v: number) => fmtCents(v) },
                            { title: '含税合计(元)', dataIndex: 'amountInclCents', width: 140, align: 'right', render: (v: number) => <Text strong>{fmtCents(v)}</Text> },
                          ]} />
                      ),
                    },
                    {
                      key: 'month', label: '按月',
                      children: (
                        <Table<InvoiceSummary['byMonth'][number]> rowKey="month" size="small" pagination={false}
                          dataSource={summary?.byMonth ?? []}
                          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该区间暂无开票记录" /> }}
                          columns={[
                            { title: '月份', dataIndex: 'month', width: 110 },
                            { title: '张数', dataIndex: 'count', width: 90, align: 'right' },
                            { title: '不含税(元)', dataIndex: 'amountExclCents', width: 130, align: 'right', render: (v: number) => fmtCents(v) },
                            { title: '税额(元)', dataIndex: 'taxCents', width: 120, align: 'right', render: (v: number) => fmtCents(v) },
                            { title: '含税合计(元)', dataIndex: 'amountInclCents', width: 140, align: 'right', render: (v: number) => <Text strong>{fmtCents(v)}</Text> },
                          ]} />
                      ),
                    },
                  ]} />
                </Card>

                <Card size="small" title="订单对账（订单金额 / 已开票 / 未开票 / 已收款 / 未收）"
                  extra={(
                    <Select
                      style={{ width: 320 }} size="small" showSearch optionFilterProp="label" allowClear
                      placeholder="选择订单查看同屏对账" value={focusOrderId}
                      loading={orderLoading}
                      onChange={(v) => { setOrderStatus(null); setFocusOrderId(v); if (v) void openOrderStatus(v) }}
                      options={orders.map((o) => ({ value: o.id, label: `${o.orderNo} · ${o.customerName ?? ''} · 价格 ${fmtCents(o.totalAmountCents)} 元` }))}
                    />
                  )}>
                  {!orderStatus
                    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一张订单：查看 订单金额 / 已开票（含税）/ 未开票余额 / 已收款（核销）/ 未收 的同屏对账（开票与收款互不影响，各自独立留痕）" />
                    : (
                      <div>
                        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                          <Col span={4}><Card size="small"><Statistic title="订单金额" value={fromCents(orderStatus.orderAmountCents)} precision={2} /></Card></Col>
                          <Col span={4}><Card size="small"><Statistic title="已开票（含税）" value={fromCents(orderStatus.invoicedCents)} precision={2} /></Card></Col>
                          <Col span={4}><Card size="small"><Statistic title="未开票余额" value={fromCents(orderStatus.uninvoicedCents)} precision={2} valueStyle={{ color: orderStatus.overInvoiced ? '#cf1322' : undefined }} /></Card></Col>
                          <Col span={4}><Card size="small"><Statistic title="已收款（核销）" value={fromCents(orderStatus.receivedCents)} precision={2} /></Card></Col>
                          <Col span={4}><Card size="small"><Statistic title="未收（应收余额）" value={fromCents(orderStatus.unreceivedCents)} precision={2} /></Card></Col>
                          <Col span={4}><Card size="small"><Statistic title="发票张数" value={orderStatus.invoiceCount} suffix="张" /></Card></Col>
                        </Row>
                        {orderStatus.overInvoiced && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="超额开票：已开票金额（含税）超过订单金额" description={orderStatus.warning} />}
                        <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}>
                          <Descriptions.Item label="订单号">{orderStatus.orderNo}</Descriptions.Item>
                          <Descriptions.Item label="客户">{orderStatus.customerName || '—'}</Descriptions.Item>
                          <Descriptions.Item label="订单状态">{STATUS_LABEL[orderStatus.orderStatus] ?? orderStatus.orderStatus}</Descriptions.Item>
                          <Descriptions.Item label="已作废发票">{orderStatus.voidedCount} 张（不计入统计）</Descriptions.Item>
                        </Descriptions>
                        <Table<Invoice> rowKey="id" size="small" pagination={false} dataSource={orderStatus.invoices}
                          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该订单暂无发票" /> }}
                          columns={[
                            { title: '发票号码', dataIndex: 'invoiceNo', width: 190, render: (v: string, r) => <InvoiceNoText invoiceNo={v} status={r.status} /> },
                            { title: '票种', dataIndex: 'invoiceType', width: 140, render: (v: InvoiceType) => INVOICE_TYPE_LABEL[v] ?? v },
                            { title: '开票日期', dataIndex: 'issueDate', width: 110 },
                            { title: '税率', dataIndex: 'taxRate', width: 80, render: (v: number) => rateLabel(Number(v)) },
                            { title: '不含税(元)', dataIndex: 'amountExclCents', width: 120, align: 'right', render: (v: number) => fmtCents(v) },
                            { title: '税额(元)', dataIndex: 'taxCents', width: 110, align: 'right', render: (v: number) => fmtCents(v) },
                            { title: '开票金额(元)', dataIndex: 'amountInclCents', width: 130, align: 'right', render: (v: number) => <Text strong>{fmtCents(v)}</Text> },
                            { title: '状态', dataIndex: 'status', width: 120, render: (v: InvoiceStatus, r) => (v === 'normal' ? <Tag color="success">正常</Tag> : <Tag color="error">已作废{r.voidReason ? `：${r.voidReason}` : ''}</Tag>) },
                          ]} />
                      </div>
                    )}
                </Card>
              </Space>
            ),
          }]}
        />
      </Card>

      <InvoiceFormModal
        open={modal.open} edit={modal.edit} customers={customers} orders={orders}
        onClose={(reload) => { setModal({ open: false, edit: null }); if (reload) { void load(); if (focusOrderId) void openOrderStatus(focusOrderId) } }} />

      <Modal
        title={voiding ? `作废发票 ${voiding.invoiceNo}` : '作废发票'}
        open={!!voiding} onCancel={() => { setVoiding(null); setVoidReason('作废重开') }}
        onOk={doVoid} okText="确认作废" okButtonProps={{ danger: true }} confirmLoading={voidSaving} width={480}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Alert type="warning" showIcon
            message="作废后：发票状态置为「已作废」并保留记录可查，但不再计入开票张数与金额统计；同一票号可重新开具。"
            description={voiding ? `开票金额（含税）${fmtCents(voiding.amountInclCents)} 元；作废留痕（原因/时间/操作人）。` : undefined} />
          <Text type="secondary" style={{ fontSize: 12 }}>默认原因「作废重开」，可直接点「确认作废」；需要填写具体原因时展开下方高级。</Text>
          <Collapse
            size="small" ghost
            items={[{
              key: 'adv', label: '高级：作废原因',
              children: (
                <Input.TextArea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="如：开错客户 / 金额有误 / 客户退回重开" />
              ),
            }]}
          />
        </Space>
      </Modal>
    </div>
  )
}
