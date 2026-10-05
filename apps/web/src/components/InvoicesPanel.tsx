import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Empty, Input, InputNumber, Modal,
  Row, Select, Space, Statistic, Table, Tag, Tabs, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { api, loadOptions } from '../lib/api'
import { INVOICE_STATUS_LABEL, INVOICE_TYPE_LABEL, STATUS_LABEL, TAX_RATE_OPTIONS } from '../lib/labels'
import { fmtCents, fromCents, rateLabel, taxCentsOf, toCents } from '../lib/money'
import type {
  Customer, Invoice, InvoicePage, InvoiceStatus, InvoiceSummary, InvoiceType, Order, OrderInvoiceStatus,
} from '../lib/types'

const { Text } = Typography
const { RangePicker } = DatePicker

type RangeValue = [Dayjs | null, Dayjs | null] | null

const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** 关联订单下拉选项文案：单号 · 客户 · 订单金额（含税口径与发票一致，均为「分」） */
const orderOptionLabel = (o: Order) =>
  `${o.orderNo} · ${o.customerName ?? ''} · 订单金额 ${fmtCents(o.totalAmountCents)} 元`

/**
 * 开票记录区块（I16）—— 与收款/核销并行的独立线
 * ------------------------------------------------------------------
 * · 顶部：开票数目统计卡（张数/含税/不含税/税额）+ 按客户 / 按月小计；
 * · 中部：订单对账（订单金额 / 已开票 / 未开票 / 已收款 / 未收 同屏），只读聚合；
 * · 下部：开票记录列表（客户/状态/日期区间/关键字筛选、分页）+ 新建/编辑/作废。
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
  const [modal, setModal] = useState<{ open: boolean; edit: Invoice | null }>({ open: false, edit: null })
  const [voiding, setVoiding] = useState<Invoice | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidSaving, setVoidSaving] = useState(false)
  const [focusOrderId, setFocusOrderId] = useState<number | undefined>()
  const [orderStatus, setOrderStatus] = useState<OrderInvoiceStatus | null>(null)
  const [orderLoading, setOrderLoading] = useState(false)

  useEffect(() => {
    loadOptions<Customer>('/customers', setCustomers, '客户档案')
    loadOptions<Order>('/orders', setOrders, '订单列表')
  }, [])

  /** 统计区间的查询串（同时驱动列表与统计，口径一致） */
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
      setVoiding(null); setVoidReason('')
      await load()
      if (focusOrderId) await openOrderStatus(focusOrderId)
    } catch (e) {
      message.error((e as Error).message)
    } finally { setVoidSaving(false) }
  }

  const columns: ColumnsType<Invoice> = [
    { title: '发票号码', dataIndex: 'invoiceNo', width: 150, render: (v: string, r) => (
      r.status === 'voided' ? <Text delete type="secondary">{v}</Text> : <Text strong>{v}</Text>
    ) },
    { title: '客户', dataIndex: 'customerName', width: 140, ellipsis: true },
    { title: '类型', dataIndex: 'invoiceType', width: 130, render: (v: InvoiceType) => <Tag color="blue">{INVOICE_TYPE_LABEL[v] ?? v}</Tag> },
    { title: '开票日期', dataIndex: 'issueDate', width: 105, render: (v: string) => v },
    { title: '税率', dataIndex: 'taxRate', width: 70, render: (v: number) => rateLabel(Number(v)) },
    { title: '不含税', dataIndex: 'amountExclCents', width: 100, align: 'right', render: (v: number) => fmtCents(v) },
    { title: '税额', dataIndex: 'taxCents', width: 90, align: 'right', render: (v: number) => fmtCents(v) },
    { title: '含税金额', dataIndex: 'amountInclCents', width: 110, align: 'right', render: (v: number, r) => (
      r.status === 'voided' ? <Text type="secondary" delete>{fmtCents(v)}</Text> : <Text strong>{fmtCents(v)}</Text>
    ) },
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
    { title: '经办人', dataIndex: 'operatorName', width: 90, render: (v?: string | null) => v || <Text type="secondary">未绑定</Text> },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (v: InvoiceStatus) => (v === 'normal' ? <Tag color="success">正常</Tag> : <Tag color="error">已作废</Tag>),
    },
    { title: '备注', dataIndex: 'remark', width: 140, ellipsis: true, render: (v?: string | null) => v || '—' },
    {
      title: '操作', width: 130, fixed: 'right',
      render: (_, r) => (r.status === 'normal'
        ? (
          <Space size={4}>
            <Button size="small" onClick={() => setModal({ open: true, edit: r })}>编辑</Button>
            <Button size="small" danger onClick={() => { setVoiding(r); setVoidReason('') }}>作废</Button>
          </Space>
        )
        : <Text type="secondary" style={{ fontSize: 12 }}>{r.voidReason ? `作废：${r.voidReason}` : '已作废'}</Text>),
    },
  ]

  const addonRows = [
    { label: '本期开票张数', value: summary?.count ?? 0, suffix: '张' },
    { label: '含税合计', value: fromCents(summary?.amountInclCents ?? 0), suffix: '元' },
    { label: '不含税合计', value: fromCents(summary?.amountExclCents ?? 0), suffix: '元' },
    { label: '税额合计', value: fromCents(summary?.taxCents ?? 0), suffix: '元' },
  ]

  return (
    <div>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {addonRows.map((r) => (
          <Col span={6} key={r.label}>
            <Card size="small">
              <Statistic title={r.label} value={r.value} precision={r.suffix === '张' ? 0 : 2} suffix={r.suffix} />
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        size="small" style={{ marginBottom: 12 }}
        title="开票小计（按客户 / 按月）"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>
          {summary?.from || summary?.to ? `区间：${summary?.from ?? '不限'} ~ ${summary?.to ?? '不限'}` : '区间：全部'}
        </Text>}
      >
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

      <Card
        size="small" style={{ marginBottom: 12 }}
        title="订单对账（订单金额 / 已开票 / 未开票 / 已收款 / 未收）"
        extra={(
          <Select
            style={{ width: 320 }} size="small" showSearch optionFilterProp="label" allowClear
            placeholder="选择订单查看同屏对账" value={focusOrderId}
            loading={orderLoading}
            onChange={(v) => { setOrderStatus(null); setFocusOrderId(v); if (v) void openOrderStatus(v) }}
            options={orders.map((o) => ({ value: o.id, label: orderOptionLabel(o) }))}
          />
        )}
      >
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
                  { title: '发票号码', dataIndex: 'invoiceNo', width: 150, render: (v: string, r) => (r.status === 'voided' ? <Text delete type="secondary">{v}</Text> : <Text strong>{v}</Text>) },
                  { title: '类型', dataIndex: 'invoiceType', width: 140, render: (v: InvoiceType) => INVOICE_TYPE_LABEL[v] ?? v },
                  { title: '开票日期', dataIndex: 'issueDate', width: 110 },
                  { title: '税率', dataIndex: 'taxRate', width: 80, render: (v: number) => rateLabel(Number(v)) },
                  { title: '不含税(元)', dataIndex: 'amountExclCents', width: 120, align: 'right', render: (v: number) => fmtCents(v) },
                  { title: '税额(元)', dataIndex: 'taxCents', width: 110, align: 'right', render: (v: number) => fmtCents(v) },
                  { title: '含税(元)', dataIndex: 'amountInclCents', width: 120, align: 'right', render: (v: number) => <Text strong>{fmtCents(v)}</Text> },
                  { title: '状态', dataIndex: 'status', width: 100, render: (v: InvoiceStatus, r) => (v === 'normal' ? <Tag color="success">正常</Tag> : <Tag color="error">已作废{r.voidReason ? `：${r.voidReason}` : ''}</Tag>) },
                ]} />
            </div>
          )}
      </Card>

      <Card size="small" title="开票记录">
        <Space size={8} wrap style={{ marginBottom: 12 }}>
          <Button type="primary" onClick={() => setModal({ open: true, edit: null })}>+ 新建开票</Button>
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
          <Select size="small" style={{ width: 130 }} allowClear placeholder="按状态筛选"
            value={status} onChange={(v) => { setStatus(v as InvoiceStatus); setPage(1) }}
            options={Object.entries(INVOICE_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
          <Input.Search size="small" style={{ width: 220 }} allowClear placeholder="票号/客户/订单号/备注"
            onSearch={(v) => { setKeyword(v); setPage(1) }} />
          <Button size="small" onClick={() => load()}>刷新</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>共 {data.total} 张（含已作废，作废发票不计入上方统计）</Text>
        </Space>
        <Table<Invoice> rowKey="id" size="small" loading={loading} columns={columns} dataSource={data.items}
          scroll={{ x: 1560 }}
          pagination={{
            current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: true,
            showTotal: (t) => `共 ${t} 张`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          locale={{ emptyText: <Empty description="该筛选条件下暂无开票记录 —— 点击「新建开票」登记" /> }} />
      </Card>

      <InvoiceModal open={modal.open} edit={modal.edit} customers={customers}
        onClose={(reload) => { setModal({ open: false, edit: null }); if (reload) { void load(); if (focusOrderId) void openOrderStatus(focusOrderId) } }} />

      <Modal
        title={voiding ? `作废发票 ${voiding.invoiceNo}` : '作废发票'}
        open={!!voiding} onCancel={() => { setVoiding(null); setVoidReason('') }}
        onOk={doVoid} okText="确认作废" okButtonProps={{ danger: true }} confirmLoading={voidSaving} width={480}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Alert type="warning" showIcon
            message="作废后：发票状态置为「已作废」并保留记录可查，但不再计入开票张数与金额统计；同一票号可重新开具。"
            description={voiding ? `含税金额 ${fmtCents(voiding.amountInclCents)} 元；作废不留物理删除痕迹（记录原因/时间/操作人）。` : undefined} />
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>作废原因 *</Text>
            <Input.TextArea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
              placeholder="如：开错客户 / 金额有误 / 客户退回重开" />
          </div>
        </Space>
      </Modal>
    </div>
  )
}

/** 新建/编辑开票弹窗：不含税金额 + 税率 → 自动算税额与含税（与后端定点算法逐分一致） */
function InvoiceModal({ open, edit, customers, onClose }: {
  open: boolean
  edit: Invoice | null
  customers: Customer[]
  onClose: (reload: boolean) => void
}) {
  const editing = !!edit
  const [customerId, setCustomerId] = useState<number>()
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('vat_general')
  const [taxRate, setTaxRate] = useState<number>(0.13)
  const [exclYuan, setExclYuan] = useState<number | undefined>()
  const [issueDate, setIssueDate] = useState<Dayjs | null>(dayjs())
  const [orderIds, setOrderIds] = useState<number[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [orderLoading, setOrderLoading] = useState(false)
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (edit) {
      setCustomerId(edit.customerId)
      setInvoiceNo(edit.invoiceNo)
      setInvoiceType(edit.invoiceType)
      setTaxRate(Number(edit.taxRate))
      setExclYuan(fromCents(edit.amountExclCents))
      setIssueDate(dayjs(edit.issueDate))
      setOrderIds(edit.orderRefs.map((r) => r.orderId))
      setRemark(edit.remark ?? '')
    } else {
      setCustomerId(undefined); setInvoiceNo(''); setInvoiceType('vat_general')
      setTaxRate(0.13); setExclYuan(undefined); setIssueDate(dayjs()); setOrderIds([]); setRemark('')
    }
  }, [open, edit])

  // 关联订单候选：限定本发票客户（跨客户开票会被服务端拒绝）
  useEffect(() => {
    if (!open || !customerId) { setOrders([]); return }
    setOrderLoading(true)
    api<Order[]>(`/orders?customerId=${customerId}`)
      .then(setOrders)
      .catch((e) => message.error('关联订单加载失败：' + (e as Error).message))
      .finally(() => setOrderLoading(false))
  }, [open, customerId])

  const exclCents = toCents(exclYuan ?? 0)
  const taxCents = taxCentsOf(exclCents, taxRate)
  const inclCents = exclCents + taxCents

  async function submit() {
    if (!customerId) { message.warning('请选择客户'); return }
    if (!editing && !invoiceNo.trim()) { message.warning('请填写发票号码'); return }
    if (!editing && exclCents <= 0) { message.warning('请填写不含税金额（含税金额必须大于 0）'); return }
    if (!issueDate) { message.warning('请选择开票日期'); return }
    setSaving(true)
    try {
      const body = editing
        ? {
          remark, issueDate: issueDate.format('YYYY-MM-DD'), taxRate, taxCents,
          amountInclCents: inclCents, orderIds,
        }
        : {
          invoiceNo: invoiceNo.trim(), invoiceType, customerId,
          amountExclCents: exclCents, taxRate, taxCents, amountInclCents: inclCents,
          issueDate: issueDate.format('YYYY-MM-DD'), orderIds, remark,
        }
      const res = await api<Invoice>(editing ? `/invoices/${edit!.id}` : '/invoices', { method: editing ? 'PUT' : 'POST', body })
      if (res?.warning) message.warning(res.warning)
      message.success(editing ? '发票已更新（金额关键字段不可改，如需更正请作废后重开）' : `发票 ${res.invoiceNo} 已登记`)
      onClose(true)
    } catch (e) {
      message.error((e as Error).message)
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title={editing ? `编辑发票 ${edit?.invoiceNo}` : '新建开票'}
      open={open} onCancel={() => onClose(false)} onOk={submit} confirmLoading={saving}
      okText={editing ? '保存修改' : '登记发票'} width={720}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Row gutter={12}>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>客户 *{editing ? '（不可修改）' : ''}</Text>
            <Select style={{ width: '100%' }} value={customerId} disabled={editing} showSearch optionFilterProp="label"
              placeholder="选择客户" onChange={(v) => { setCustomerId(v); setOrderIds([]) }}
              options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          </Col>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>发票号码 *{editing ? '（不可修改，如需换号请作废后重开）' : ''}</Text>
            <Input value={invoiceNo} disabled={editing} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="如 25312000000012345" />
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>发票类型 *{editing ? '（不可修改）' : ''}</Text>
            <Select style={{ width: '100%' }} value={invoiceType} disabled={editing} onChange={(v) => setInvoiceType(v as InvoiceType)}
              options={Object.entries(INVOICE_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          </Col>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>税率 *（可修改）</Text>
            <Select style={{ width: '100%' }} value={taxRate} onChange={(v) => setTaxRate(Number(v))}
              options={TAX_RATE_OPTIONS} />
          </Col>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>开票日期 *</Text>
            <DatePicker style={{ width: '100%' }} value={issueDate} onChange={(v) => setIssueDate(v)} />
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={8}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
              不含税金额（元）*{editing ? '（不可修改）' : ''}
            </Text>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} value={exclYuan} disabled={editing}
              onChange={(v) => setExclYuan((v as number) ?? undefined)} placeholder="如 10000.00" />
          </Col>
          <Col span={16}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>自动计算（税额 = 不含税 × 税率，四舍五入到分；含税 = 不含税 + 税额）</Text>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="税额">{fmtCents(taxCents)} 元</Descriptions.Item>
              <Descriptions.Item label="含税金额"><Text strong>{fmtCents(inclCents)} 元</Text></Descriptions.Item>
            </Descriptions>
          </Col>
        </Row>

        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
            关联订单（可多选，也可不选；仅可关联本客户的订单，已开票金额实时聚合）
          </Text>
          <Select mode="multiple" style={{ width: '100%' }} value={orderIds} loading={orderLoading}
            showSearch optionFilterProp="label" allowClear placeholder="选择订单（可留空）"
            onChange={(v) => setOrderIds(v as number[])}
            notFoundContent={customerId ? '该客户暂无订单' : '请先选择客户'}
            options={orders.map((o) => ({ value: o.id, label: orderOptionLabel(o) }))} />
        </div>

        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>备注</Text>
          <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="选填（如：本次开票为第一批货款）" />
        </div>

        <Text type="secondary" style={{ fontSize: 12 }}>
          校验口径：含税金额 = 不含税金额 + 税额，税额 = round(不含税金额 × 税率)；三者不为负且含税金额 &gt; 0。
          金额为开票凭证关键字段，登记后不可直接修改（改金额需作废后重开）；允许部分开票，累计超出订单金额时仅提示、不阻断。
        </Text>
      </Space>
    </Modal>
  )
}
