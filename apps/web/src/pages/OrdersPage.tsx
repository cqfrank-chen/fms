import { useEffect, useMemo, useState } from 'react'
import {
  Button, Card, DatePicker, Descriptions, Form, Input, InputNumber, Modal,
  Select, Space, Table, Tabs, Tag, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { PACK_LABEL, PRODUCT_TYPE_LABEL, STATUS_LABEL } from '../lib/labels'
import type { Customer, Order, OrderLine, PackagingSpec, PlanSheet, Product } from '../lib/types'
import PackComboEditor from '../components/PackComboEditor'

const { Text } = Typography

/** 订单页：新建（一单多产品+复合包装） / 订单列表（筛选+详情） / 归档（已完成反查） */
export default function OrdersPage() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>订单</Typography.Title>
      <Tabs
        items={[
          { key: 'new', label: '+ 新建订单', children: <OrderCreateCard /> },
          { key: 'list', label: '订单列表', children: <OrderListTable archived={false} /> },
          { key: 'archive', label: '归档（已完成）', children: <OrderListTable archived /> },
        ]}
      />
    </div>
  )
}

/** 新建订单：单头 + 多产品行（行含刻字/复合包装） */
function OrderCreateCard() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<Customer[]>('/customers').then(setCustomers).catch(() => {})
    api<Product[]>('/products').then(setProducts).catch(() => {})
  }, [])

  const defaultLine: OrderLine = {
    productId: undefined as unknown as number,
    quantity: 1000,
    unitPrice: 3.5,
    currency: 'RMB',
  }

  async function handleSave() {
    const values = await form.validateFields()
    // 行校验：产品必选、数量/单价为正
    const lines = (values.lines ?? []).filter((l: OrderLine) => l.productId)
    if (!lines.length) { message.warning('至少加一个产品行'); return }
    setSaving(true)
    try {
      const created = await api<Order>('/orders', {
        method: 'POST',
        body: {
          customerId: values.customerId,
          poNo: values.poNo,
          dueDate: values.dueDate.toISOString(),
          note: values.note,
          lines: lines.map((l: OrderLine) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            currency: l.currency,
            engraving: l.engraving || undefined,
            packaging: (l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined),
          })),
        },
      })
      message.success(`订单已保存为草稿：${created.orderNo}（确认动作 I05 实施）`)
      form.resetFields()
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally { setSaving(false) }
  }

  const lineColumns = (remove: (index: number) => void) => [
    {
      title: '产品（目录）',
      width: 240,
      render: (_: unknown, __: unknown, index: number) => (
        <Form.Item name={['lines', index, 'productId']} rules={[{ required: true, message: '必选产品' }]} style={{ marginBottom: 0 }}>
          <Select placeholder="选择产品" showSearch optionFilterProp="label"
            options={products.map((p) => ({ value: p.id, label: `${p.name}（${PRODUCT_TYPE_LABEL[p.type]}）` }))} />
        </Form.Item>
      ),
    },
    {
      title: '数量', width: 110,
      render: (_: unknown, __: unknown, index: number) => (
        <Form.Item name={['lines', index, 'quantity']} rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 0 }}>
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '单价', width: 100,
      render: (_: unknown, __: unknown, index: number) => (
        <Form.Item name={['lines', index, 'unitPrice']} rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 0 }}>
          <InputNumber min={0} precision={2} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '币种', width: 80,
      render: (_: unknown, __: unknown, index: number) => (
        <Form.Item name={['lines', index, 'currency']} style={{ marginBottom: 0 }}>
          <Select options={[{ value: 'RMB', label: 'RMB' }, { value: 'USD', label: 'USD' }]} />
        </Form.Item>
      ),
    },
    {
      title: '刻字需求', width: 160,
      render: (_: unknown, __: unknown, index: number) => (
        <Form.Item name={['lines', index, 'engraving']} style={{ marginBottom: 0 }}>
          <Input placeholder="如 LOGO/型号/批次 ✒" />
        </Form.Item>
      ),
    },
    {
      title: '包装要求（可多选）',
      render: (_: unknown, __: unknown, index: number) => (
        <Form.Item name={['lines', index, 'packaging']} style={{ marginBottom: 0 }}>
          <PackComboEditor />
        </Form.Item>
      ),
    },
    {
      title: '', width: 48,
      render: (_: unknown, __: unknown, index: number) => (
        <Button type="text" danger size="small" onClick={() => remove(index)}>删</Button>
      ),
    },
  ]

  return (
    <Card title="新建订单" extra={<Typography.Text type="secondary">保存即草稿；确认生成计划单为 I05 动作</Typography.Text>}>
      <div style={{ border: '2px dashed #91caff', borderRadius: 8, padding: 14, textAlign: 'center', color: '#0958d9', marginBottom: 16, background: '#e6f4ff' }}>
        📷 <Text strong>图片识别导入订单（AI）</Text>
        <div style={{ fontSize: 12 }}>上传客户邮件/微信传单/拍照图自动识别 —— 功能 I12 接入，此处为入口占位</div>
      </div>

      <Form form={form} layout="vertical" initialValues={{}}>
        <Space wrap align="start" size={16}>
          <Form.Item name="customerId" label="客户档案 *" rules={[{ required: true, message: '必选客户' }]} style={{ minWidth: 220 }}>
            <Select placeholder="请选择客户" showSearch optionFilterProp="label"
              options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="poNo" label="客户 PO 号" style={{ minWidth: 160 }}>
            <Input placeholder="选填" />
          </Form.Item>
          <Form.Item name="dueDate" label="交期 *" rules={[{ required: true, message: '必填交期' }]}>
            <DatePicker style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="note" label="备注" style={{ minWidth: 220 }}>
            <Input placeholder="选填" />
          </Form.Item>
        </Space>

        <Typography.Text strong>订单行（一单可多产品）</Typography.Text>
        <Form.List name="lines" initialValue={[defaultLine]}>
          {(fields, { add, remove }) => (
            <>
              <Table
                rowKey={(_, i) => String(i)}
                pagination={false}
                size="small"
                style={{ marginTop: 8, marginBottom: 8 }}
                columns={lineColumns(remove)}
                dataSource={fields}
                locale={{ emptyText: '暂无行' }}
              />
              <Space>
                <Button onClick={() => add({ ...defaultLine })}>+ 加一行</Button>
                <Button type="primary" loading={saving} onClick={handleSave}>保存订单（草稿）</Button>
              </Space>
            </>
          )}
        </Form.List>
      </Form>
    </Card>
  )
}

/** 订单列表 / 归档（archived=已完成） */
function OrderListTable({ archived }: { archived: boolean }) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [rows, setRows] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [customerId, setCustomerId] = useState<number | undefined>()
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<Order | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  async function doConfirm(r: Order) {
    setConfirmingId(r.id)
    try {
      const plan = await api<PlanSheet>(`/orders/${r.id}/confirm`, { method: 'POST' })
      message.success(`已确认并生成计划单 ${plan.planNo}（草稿，待审核）`)
      fetchRows()
    } catch (e) {
      message.error('确认失败：' + (e as Error).message)
    } finally { setConfirmingId(null) }
  }

  useEffect(() => { api<Customer[]>('/customers').then(setCustomers).catch(() => {}) }, [])

  async function fetchRows() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (archived) params.set('status', 'completed')
      else if (status) params.set('status', status)
      if (customerId) params.set('customerId', String(customerId))
      if (kw.trim()) params.set('kw', kw.trim())
      setRows(await api<Order[]>(`/orders?${params.toString()}`))
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally { setLoading(false) }
  }
  useEffect(() => { fetchRows() }, [archived, status, customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  const columns: ColumnsType<Order> = useMemo(() => [
    { title: '订单号', dataIndex: 'orderNo', width: 170, render: (v: string) => <Text strong>{v}</Text> },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    { title: 'PO号', dataIndex: 'poNo', width: 120, render: (v?: string | null) => v || '—' },
    {
      title: '产品行', render: (_: unknown, r: Order) => (
        <Space direction="vertical" size={2}>
          {r.lines?.map((l: OrderLine, i: number) => (
            <div key={i} style={{ fontSize: 12 }}>
              {l.productName} × {l.quantity}{l.engraving ? ` ✒${l.engraving}` : ''}
            </div>
          ))}
        </Space>
      ),
    },
    { title: '交期', dataIndex: 'dueDate', width: 110, render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => <Tag color={v === 'completed' ? 'success' : v === 'draft' ? 'default' : 'processing'}>{STATUS_LABEL[v] ?? v}</Tag>,
    },
    {
      title: '操作', width: 170,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'draft' && (
            <Button type="primary" size="small" loading={confirmingId === r.id} onClick={() => doConfirm(r)}>确认</Button>
          )}
          <Button size="small" onClick={() => setDetail(r)}>详情</Button>
        </Space>
      ),
    },
  ], [confirmingId])

  const filterBar = !archived && (
    <Space wrap style={{ marginBottom: 12 }}>
      <Select style={{ width: 130 }} value={status} onChange={setStatus} placeholder="全部状态"
        options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} allowClear />
      <Select style={{ width: 180 }} value={customerId} onChange={setCustomerId} placeholder="全部客户"
        options={customers.map((c) => ({ value: c.id, label: c.name }))} allowClear />
      <Input.Search placeholder="单号/PO号搜索" style={{ width: 200 }} allowClear
        onSearch={(v) => { setKw(v); fetchRows() }} />
      <Button onClick={fetchRows}>查询</Button>
    </Space>
  )

  return (
    <Card title={archived ? '归档（已完成订单 · 可反查）' : '订单列表'} size="small">
      {filterBar}
      {archived && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '16px 0', color: '#999' }}>
          暂无已完成订单 —— 订单完成自动进归档（I05/I06 实施）
        </div>
      )}
      <Table<Order> rowKey="id" loading={loading} size="small" columns={columns} dataSource={rows}
        pagination={{ pageSize: 10, showSizeChanger: false }} />
      <OrderDetailDrawer order={detail} onClose={() => setDetail(null)} />
    </Card>
  )
}

/** 订单详情：单头 + 行（刻字/包装/币种单价） */
function OrderDetailDrawer({ order, onClose }: { order: Order | null; onClose: () => void }) {
  if (!order) return <Modal open={false} onCancel={onClose} footer={null} />
  const packText = (p?: PackagingSpec | null) => {
    if (!p || !Object.keys(p).length) return '—'
    return Object.entries(p).map(([k, v]) => `${PACK_LABEL[k] ?? k}${v ? '：' + v : ''}`).join('；')
  }
  return (
    <Modal title={`订单详情 ${order.orderNo}`} open onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={760}>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="客户">{order.customerName}</Descriptions.Item>
        <Descriptions.Item label="PO号">{order.poNo || '—'}</Descriptions.Item>
        <Descriptions.Item label="状态"><Tag color="processing">{STATUS_LABEL[order.status]}</Tag></Descriptions.Item>
        <Descriptions.Item label="交期">{dayjs(order.dueDate).format('YYYY-MM-DD')}</Descriptions.Item>
        <Descriptions.Item label="备注" span={2}>{order.note || '—'}</Descriptions.Item>
      </Descriptions>
      <Table<OrderLine>
        rowKey={(_, i) => String(i)}
        size="small"
        pagination={false}
        columns={[
          { title: '产品', dataIndex: 'productName' },
          { title: '数量', dataIndex: 'quantity', width: 90, align: 'right' },
          { title: '单价', dataIndex: 'unitPrice', width: 90, align: 'right', render: (v: number) => v.toFixed(2) },
          { title: '币种', dataIndex: 'currency', width: 70 },
          { title: '刻字', dataIndex: 'engraving', width: 140, render: (v?: string | null) => v || '—' },
          { title: '包装要求', dataIndex: 'packaging', render: packText },
        ]}
        dataSource={order.lines}
      />
    </Modal>
  )
}
