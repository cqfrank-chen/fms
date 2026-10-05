import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row,
  Select, Space, Statistic, Table, Tabs, Tag, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api, loadOptions } from '../lib/api'
import { IQC_LABEL, OQC_LABEL, OUTBOUND_STATUS_LABEL, RECEIPT_STATUS_LABEL } from '../lib/labels'
import { optionLabel, optionsPath } from '../lib/placeholders'
import type {
  Customer, GoodsReceipt, IncomingGoods, InventoryRow, Order, OrderLine,
  Outbound, Product, Stocktake, Supplier,
} from '../lib/types'

const { Text } = Typography

const stColor = (v: string) => (v === 'voided' ? 'error' : v === 'confirmed' || v === 'shipped' ? 'success' : 'default')
const R = RECEIPT_STATUS_LABEL

/** 仓储页（I08）：库存 / 入库确认 / 出库（挂订单·OQC）/ 来料登记 / 盘点 */
function WarehousePage() {
  const [tab, setTab] = useState('stock')
  return (
    <Card size="small" styles={{ body: { paddingTop: 4 } }}>
      <Tabs activeKey={tab} onChange={setTab} size="small" destroyOnHidden items={[
        { key: 'stock', label: '库存列表', children: <StockTab /> },
        { key: 'inbound', label: '入库确认', children: <ReceiptsTab /> },
        { key: 'outbound', label: '出库单', children: <OutboundTab /> },
        { key: 'incoming', label: '来料登记', children: <IncomingTab /> },
        { key: 'stocktake', label: '盘点', children: <StocktakeTab /> },
      ]} />
    </Card>
  )
}

/** 库存：按产品聚合为组行，展开看各批次明细；低库存=产品总库存<安全库存 */
interface StockGroupRow {
  id: string
  productId: number
  productName: string
  quantity: number
  safetyStock: number
  low: boolean
  batchCount: number
  updatedAt?: string
  children: InventoryRow[]
}
type StockTableRow = StockGroupRow | InventoryRow
const isGroup = (r: StockTableRow): r is StockGroupRow => Array.isArray((r as StockGroupRow).children)

const stockTime = (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—')

function StockTab() {
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<InventoryRow[]>('/inventory')) }
    catch (e) { message.error('库存加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // 同产品合并：组行=总库存/安全库存/状态，children=各批次（最新在前）
  const groups = useMemo<StockGroupRow[]>(() => {
    const byId = new Map<number, InventoryRow[]>()
    for (const r of rows) {
      const arr = byId.get(r.productId) ?? []
      arr.push(r)
      byId.set(r.productId, arr)
    }
    return [...byId.entries()]
      .map(([productId, items]) => {
        const sorted = [...items].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        const total = items.reduce((s, r) => s + r.quantity, 0)
        const safetyStock = items[0].safetyStock ?? 0
        return {
          id: `p${productId}`,
          productId,
          productName: items[0].productName ?? `#${productId}`,
          quantity: total,
          safetyStock,
          low: total < safetyStock,
          batchCount: items.length,
          updatedAt: sorted[0]?.updatedAt || undefined,
          children: sorted,
        }
      })
      .sort((a, b) => a.productName.localeCompare(b.productName, 'zh'))
  }, [rows])

  const total = groups.reduce((s, g) => s + g.quantity, 0)
  const lowCount = groups.filter((g) => g.low).length

  const columns: ColumnsType<StockTableRow> = [
    {
      title: '产品', dataIndex: 'productName',
      render: (_, r) => isGroup(r)
        ? <Text strong>{r.productName}</Text>
        : <Text type="secondary" style={{ fontSize: 12 }}>批次明细</Text>,
    },
    {
      title: '批次', dataIndex: 'batchNo', width: 190,
      render: (_, r) => isGroup(r)
        ? <Text type="secondary" style={{ fontSize: 12 }}>共 {r.batchCount} 个批次</Text>
        : <Text style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }}>{r.batchNo}</Text>,
    },
    {
      title: '库存数', dataIndex: 'quantity', width: 110, align: 'right',
      render: (v: number, r) => {
        const warn = isGroup(r) ? r.low : v < 0 // 子行：负数为异常标红
        return <Text style={{ color: warn ? '#cf1322' : undefined, fontWeight: isGroup(r) && r.low ? 600 : undefined }}>{v}</Text>
      },
    },
    { title: '安全库存', width: 100, align: 'right', render: (_, r) => (isGroup(r) ? <Text>{r.safetyStock}</Text> : '—') },
    {
      title: '状态', width: 130,
      render: (_, r) => isGroup(r)
        ? (r.low ? <Tag color="error">低于安全库存</Tag> : <Tag color="success">正常</Tag>)
        : null,
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 150, render: (v?: string) => stockTime(v) },
  ]
  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 12 }} align="middle">
        <Col span={5}><Card size="small"><Statistic title="库存总数量（只）" value={total} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="低于安全库存（产品数）" value={lowCount} valueStyle={{ color: lowCount ? '#cf1322' : undefined }} /></Card></Col>
        <Col span={13} style={{ textAlign: 'right' }}>
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>共 {groups.length} 个产品 · {rows.length} 个批次</Text>
            <Button size="small" disabled={!groups.length} onClick={() => setExpandedKeys(groups.map((g) => g.id))}>展开全部</Button>
            <Button size="small" disabled={!groups.length} onClick={() => setExpandedKeys([])}>收起全部</Button>
          </Space>
        </Col>
      </Row>
      <Table<StockTableRow>
        rowKey={(r) => String(r.id)}
        size="small" loading={loading}
        columns={columns} dataSource={groups}
        pagination={false}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys) => setExpandedKeys(keys.map(String)),
        }}
        locale={{ emptyText: <Empty description="暂无库存 —— 报工后在「入库确认」核实物数入账" /> }} />
    </div>
  )
}

/** 入库确认：报工草稿 / 手动无单入库 → 仓管确认入账 → 冲销纠错 */
function ReceiptsTab() {
  const [rows, setRows] = useState<GoodsReceipt[]>([])
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState<number | null>(null)
  // 无单入库：备货/打样/返工回仓 手动建档（不进应收/成本账）
  const [manualOpen, setManualOpen] = useState(false)
  const [prods, setProds] = useState<Product[]>([])
  const [mForm] = Form.useForm()
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<GoodsReceipt[]>('/receipts')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const openManual = async () => {
    setManualOpen(true)
    // 甲方裁定 2：产品**选择下拉**始终显示占位档案（不受「显示占位档案」开关影响）
    try { setProds(await api<Product[]>(optionsPath('/products'))) } catch { /* 产品下拉失败不阻塞 */ }
  }
  const saveManual = async () => {
    const v = await mForm.validateFields()
    try {
      await api('/receipts/manual', { method: 'POST', body: v })
      message.success('已生成入库草稿（来源：手动无单），核对后点「确认入库」入账')
      setManualOpen(false)
      mForm.resetFields()
      load()
    } catch (e) { message.error('创建失败：' + (e as Error).message) }
  }

  async function act(id: number, action: string, okMsg: string) {
    setActing(id)
    try { await api(`/receipts/${id}/${action}`, { method: 'POST' }); message.success(okMsg); load() }
    catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  const columns: ColumnsType<GoodsReceipt> = [
    { title: '入库单号', dataIndex: 'receiptNo', width: 160, render: (v: string) => <Text strong>{v}</Text> },
    {
      title: '来源', dataIndex: 'planNo', width: 170,
      render: (v?: string, r?: GoodsReceipt) => r?.planSheetId
        ? v
        : <Tag color="blue">手动无单入库</Tag>,
    },
    {
      title: '入库产品', render: (_, r) => (
        <Space direction="vertical" size={2}>
          {r.lines?.map((l, i) => (
            <div key={i} style={{ fontSize: 12 }}>{l.productName} × {l.quantity}</div>
          ))}
        </Space>
      ),
    },
    { title: '批次', dataIndex: 'batchNo', width: 150 },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={stColor(v)}>{R[v]}</Tag> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—') },
    { title: '经办人', dataIndex: 'operatorName', width: 90, render: (v?: string | null) => v || <Text type="secondary">—</Text> },
    {
      title: '操作', width: 170, render: (_, r) => (
        <Space size={4}>
          {r.status === 'draft' && (
            <Button type="primary" size="small" loading={acting === r.id} onClick={() => act(r.id, 'confirm', '已确认入账，库存+')}>确认入库</Button>
          )}
          {r.status === 'confirmed' && (
            <Popconfirm title="冲销将回减库存，确认？" onConfirm={() => act(r.id, 'void', '已冲销，库存回减')}>
              <Button size="small" danger loading={acting === r.id}>冲销</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>无订单成品入库（备货生产 / 打样 / 返工回仓）点右侧「无单入库」建档</Text>
        <Button size="small" type="dashed" onClick={openManual}>＋ 无单入库</Button>
      </div>
      <Table<GoodsReceipt> rowKey="id" size="small" loading={loading} columns={columns} dataSource={rows}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description="暂无入库单 —— 报工自动生成草稿，或点上方「无单入库」手动建档" /> }} />
      <Modal title="无订单手动入库" open={manualOpen} onCancel={() => setManualOpen(false)} onOk={saveManual} okText="生成入库草稿" width={480}>
        <Form form={mForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="productId" label="产品" rules={[{ required: true, message: '请选择产品' }]}>
            <Select placeholder="选择入库产品" options={prods.map((p) => ({ value: p.id, label: optionLabel(p.name) }))} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="quantity" label="数量（只）" rules={[{ required: true, message: '请输入数量' }]}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="正数" />
          </Form.Item>
          <Form.Item name="batchNo" label="批次号（留空自动生成 FG-日期-序号）">
            <Input placeholder="如：FG-20260907-12（返工回仓可自定便于追溯）" />
          </Form.Item>
          <Form.Item name="note" label="备注（说明来源，如：备货 / 打样 / 返工回仓）">
            <Input placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

/** 出库：挂订单 + 可分批 + OQC 先检后出 */
function OutboundTab() {
  const [rows, setRows] = useState<Outbound[]>([])
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState<number>()
  const [oqc, setOqc] = useState<'pending' | 'exempt'>('pending')
  const [orderLines, setOrderLines] = useState<OrderLine[]>([])
  const [qtys, setQtys] = useState<Record<number, number>>({})
  const [creating, setCreating] = useState(false)
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<Outbound[]>('/outbounds')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    // 甲方裁定 2：客户**选择下拉**始终显示占位档案（不受「显示占位档案」开关影响）
    loadOptions<Customer>(optionsPath('/customers'), setCustomers, '客户档案')
  }, [])

  async function openCreate() {
    setOpen(true)
    setOrderId(undefined)
    setOrderLines([])
    setQtys({})
    setOqc('pending')
    try { setOrders(await api<Order[]>('/orders')) }
    catch (e) { message.error('订单加载失败：' + (e as Error).message) }
  }

  async function pickOrder(id: number) {
    setOrderId(id)
    try {
      const o = await api<Order>(`/orders/${id}`)
      setOrderLines(o.lines)
      const init: Record<number, number> = {}
      for (const l of o.lines) init[l.id ?? -1] = l.quantity
      setQtys(init)
    } catch (e) { message.error('订单详情加载失败：' + (e as Error).message) }
  }

  async function create() {
    if (!orderId) { message.warning('请选择要发货的订单'); return }
    const lines = orderLines
      .filter((l) => (qtys[l.id ?? -1] ?? 0) > 0)
      .map((l) => ({ orderLineId: l.id!, quantity: qtys[l.id ?? -1] }))
    if (!lines.length) { message.warning('至少一行出库数量 > 0'); return }
    setCreating(true)
    try {
      const ob = await api<Outbound>('/outbounds', { method: 'POST', body: { orderId, oqc, lines } })
      message.success(`出库单 ${ob.shipNo} 已创建`)
      setOpen(false)
      load()
    } catch (e) { message.error('创建失败：' + (e as Error).message) }
    finally { setCreating(false) }
  }

  async function act(id: number, action: string, okMsg: string) {
    setActing(id)
    try {
      await api<any>(`/outbounds/${id}/${action}`, { method: 'POST' })
      message.success(okMsg)
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  const columns: ColumnsType<Outbound> = [
    { title: '出库单号', dataIndex: 'shipNo', width: 160, render: (v: string) => <Text strong>{v}</Text> },
    { title: '订单', dataIndex: 'orderNo', width: 160 },
    { title: '客户', dataIndex: 'customerName', width: 140 },
    {
      title: '产品行', render: (_, r) => (
        <Space direction="vertical" size={2}>
          {r.lines?.map((l, i) => (
            <div key={i} style={{ fontSize: 12 }}>{l.productName} × {l.quantity}</div>
          ))}
        </Space>
      ),
    },
    { title: 'OQC', dataIndex: 'oqc', width: 90, render: (v: string) => <Tag>{OQC_LABEL[v] ?? v}</Tag> },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <Tag color={stColor(v)}>{OUTBOUND_STATUS_LABEL[v] ?? v}</Tag> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—') },
    { title: '经办人', dataIndex: 'operatorName', width: 90, render: (v?: string | null) => v || <Text type="secondary">—</Text> },
    {
      title: '操作', width: 230, render: (_, r) => (
        <Space size={4}>
          {r.status === 'draft' && (
            <Button type="primary" size="small" loading={acting === r.id} onClick={() => act(r.id, 'submit', r.oqc === 'exempt' ? '免检直出：库存已扣' : '已提交，OQC 待检')}>
              {r.oqc === 'exempt' ? '确认出库' : '提交出库'}
            </Button>
          )}
          {r.status === 'pending' && (
            <Popconfirm title="OQC 合格放行 → 扣减库存？" onConfirm={() => act(r.id, 'oqc-pass', 'OQC 放行：库存已扣')}>
              <Button type="primary" size="small" ghost loading={acting === r.id}>OQC 放行</Button>
            </Popconfirm>
          )}
          {r.status === 'shipped' && (
            <Popconfirm title="冲销将回补库存，并按本次退回金额冲减订单应收（未核销部分），确认？" onConfirm={() => act(r.id, 'void', '已冲销：库存回补，订单应收已冲减')}>
              <Button size="small" danger loading={acting === r.id}>冲销</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const custName = (cid: number) => customers.find((c) => c.id === cid)?.name ?? ''
  const availOrders = orders.filter((o) => o.status === 'confirmed' || o.status === 'production' || o.status === 'completed')
  const orderStatusLabel: Record<string, string> = { draft: '草稿', confirmed: '已确认', production: '生产中', completed: '已完成', cancelled: '已取消' }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={openCreate}>+ 新建出库单</Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
          挂订单发货 · 可分批 · OQC 先检后出（应收在订单确认时已开立，放行仅扣库存）
        </Text>
      </div>
      <Table<Outbound> rowKey="id" size="small" loading={loading} columns={columns} dataSource={rows}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description="暂无出库单 —— 点「新建出库单」对已确认订单发货" /> }} />
      <Modal title="新建出库单" open={open} onCancel={() => setOpen(false)} onOk={create} confirmLoading={creating} okText="创建出库单" width={680}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>选择订单（已确认/生产中/已完成）</Text>
            <Select style={{ width: '100%' }} value={orderId} onChange={pickOrder} placeholder="选择要发货的订单" showSearch optionFilterProp="label"
              options={availOrders.map((o) => ({
                value: o.id,
                label: `${o.orderNo} · ${custName(o.customerId)} · ${orderStatusLabel[o.status] ?? o.status}`,
              }))} />
          </div>
          {orderId && orderLines.length > 0 && (
            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>发货数量（默认整单全出，可改小=分批）</Text>
              {orderLines.map((l) => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Text style={{ width: 240, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.productName} × {l.quantity}
                  </Text>
                  <InputNumber style={{ width: 140 }} min={0} max={l.quantity} value={qtys[l.id ?? -1]}
                    onChange={(v) => setQtys((p) => ({ ...p, [l.id ?? -1]: (v as number) ?? 0 }))} />
                </div>
              ))}
            </div>
          )}
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>OQC 模式</Text>
            <Select style={{ width: 220 }} value={oqc} onChange={setOqc} options={[
              { value: 'pending', label: '待检（先检后出）' },
              { value: 'exempt', label: '免检（直出）' },
            ]} />
          </div>
        </Space>
      </Modal>
    </div>
  )
}

/** 来料登记：轻登记 + 自动生成应付 */
function IncomingTab() {
  const [rows, setRows] = useState<IncomingGoods[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [creating, setCreating] = useState(false)
  const [acting, setActing] = useState<number | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<IncomingGoods[]>('/incoming-goods')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    loadOptions<Supplier>('/suppliers', setSuppliers, '供应商档案')
    // 甲方裁定 2：产品**选择下拉**始终显示占位档案（不受「显示占位档案」开关影响）
    loadOptions<Product>(optionsPath('/products'), setProducts, '产品目录')
  }, [])

  async function create() {
    const v = await form.validateFields()
    setCreating(true)
    try {
      await api('/incoming-goods', { method: 'POST', body: { ...v, materialName: v.materialName } })
      message.success('来料已登记，应付账款已自动生成')
      setOpen(false)
      form.resetFields()
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setCreating(false) }
  }

  async function voidRow(id: number) {
    setActing(id)
    try {
      await api(`/incoming-goods/${id}/void`, { method: 'POST' })
      message.success('已冲销：不再计入材料成本，关联应付同步冲销')
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  const columns: ColumnsType<IncomingGoods> = [
    { title: '登记单号', dataIndex: 'incomingNo', width: 160, render: (v: string) => <Text strong>{v}</Text> },
    { title: '登记/更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string, r?: IncomingGoods) => <Text type="secondary" style={{ fontSize: 12 }}>{(v ?? r?.createdAt ?? '').slice(0, 16).replace('T', ' ')}</Text> },
    { title: '供应商', dataIndex: 'supplierName', width: 140 },
    { title: '物料', dataIndex: 'materialName' },
    { title: '数量', dataIndex: 'quantity', width: 90 },
    { title: '金额(元)', dataIndex: 'amount', width: 110 },
    { title: '批次', dataIndex: 'batchNo', width: 150, render: (v?: string | null) => v || '—' },
    { title: 'IQC', dataIndex: 'iqcStatus', width: 110, render: (v: string) => <Tag color="orange">{IQC_LABEL[v] ?? v}</Tag> },
    { title: '状态', dataIndex: 'status', width: 90, render: (v?: string) => <Tag color={stColor(v ?? 'confirmed')}>{R[v ?? 'confirmed'] ?? v}</Tag> },
    { title: '经办人', dataIndex: 'operatorName', width: 90, render: (v?: string | null) => v || <Text type="secondary">—</Text> },

    {
      title: '操作', width: 100, render: (_, r) => (
        (r.status ?? 'confirmed') === 'confirmed'
          ? (
            <Popconfirm title="冲销将不再计入材料成本，并同步冲销未核销的应付；确认？" onConfirm={() => voidRow(r.id)}>
              <Button size="small" danger loading={acting === r.id}>冲销</Button>
            </Popconfirm>
          )
          : <Text type="secondary" style={{ fontSize: 12 }}>已冲销</Text>
      ),
    },
  ]
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { form.resetFields(); setOpen(true) }}>+ 来料登记</Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>铜料等原料轻登记（IQC 一期线下纸质预留），带金额自动生成应付</Text>
      </div>
      <Table<IncomingGoods> rowKey="id" size="small" loading={loading} columns={columns} dataSource={rows}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }} />
      <Modal title="来料登记单" open={open} onCancel={() => setOpen(false)} onOk={create} confirmLoading={creating} okText="登记（生成应付）">
        <Form form={form} layout="vertical">
          <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: '必选' }]}>
            <Select placeholder="选择供应商" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="materialName" label="物料" rules={[{ required: true, message: '必填' }]}>
            <Select showSearch placeholder="如 黄铜棒 φ20" options={[...new Set(['黄铜棒 φ20', '黄铜棒 φ25', '包装盒', '不干胶'].concat(products.map((p) => p.name)))]
              .map((n) => ({ value: n, label: optionLabel(n) }))} />
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true, message: '必填' }]}>
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item name="amount" label="金额（元，生成应付）" rules={[{ required: true, message: '必填' }]}>
            <InputNumber style={{ width: '100%' }} min={0.01} precision={2} />
          </Form.Item>
          <Form.Item name="batchNo" label="批次号（供应商追溯，可空）">
            <Input placeholder="如 B20260904-01" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

/** 盘点：选 SKU×批次 → 实盘 → 确认校准 */
function StocktakeTab() {
  const [rows, setRows] = useState<Stocktake[]>([])
  const [invs, setInvs] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [invKey, setInvKey] = useState<number>()
  const [actualQty, setActualQty] = useState<number>()
  const [creating, setCreating] = useState(false)
  const [acting, setActing] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<Stocktake[]>('/stocktakes')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function openCreate() {
    setOpen(true)
    setInvKey(undefined)
    setActualQty(undefined)
    try { setInvs(await api<InventoryRow[]>('/inventory')) }
    catch (e) { message.error('库存加载失败：' + (e as Error).message) }
  }
  const cur = invs.find((i) => i.id === invKey)

  async function create() {
    if (!cur) { message.warning('请选择要盘点的库存行'); return }
    if (actualQty == null) { message.warning('请填写实盘数'); return }
    setCreating(true)
    try {
      await api('/stocktakes', { method: 'POST', body: { productId: cur.productId, batchNo: cur.batchNo, actualQty } })
      message.success('盘点单已建档（草稿），确认后校准库存')
      setOpen(false)
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setCreating(false) }
  }

  async function confirm(id: number) {
    setActing(id)
    try { await api(`/stocktakes/${id}/confirm`, { method: 'POST' }); message.success('已确认，库存校准'); load() }
    catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  async function voidRow(id: number) {
    setActing(id)
    try {
      await api(`/stocktakes/${id}/void`, { method: 'POST' })
      message.success('已冲销：盘盈/盘亏调整已反向应用')
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  const columns: ColumnsType<Stocktake> = [
    { title: '盘点单号', dataIndex: 'stocktakeNo', width: 160, render: (v: string) => <Text strong>{v}</Text> },
    { title: 'SKU', dataIndex: 'productName', width: 200 },
    { title: '批次', dataIndex: 'batchNo', width: 150 },
    { title: '账面数', dataIndex: 'bookQty', width: 90 },
    { title: '实盘数', dataIndex: 'actualQty', width: 90 },
    {
      title: '差异', dataIndex: 'diffQty', width: 100,
      render: (v: number) => <Text type={v === 0 ? 'secondary' : v > 0 ? 'success' : 'danger'}>{v > 0 ? `盘盈 +${v}` : v < 0 ? `盘亏 ${v}` : '无差异'}</Text>,
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={stColor(v)}>{R[v]}</Tag> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—') },
    { title: '经办人', dataIndex: 'operatorName', width: 90, render: (v?: string | null) => v || <Text type="secondary">—</Text> },
    {
      title: '操作', width: 150, render: (_, r) => (
        r.status === 'draft'
          ? <Popconfirm title="按实盘数校准库存，确认？" onConfirm={() => confirm(r.id)}><Button type="primary" size="small" loading={acting === r.id}>确认校准</Button></Popconfirm>
          : r.status === 'confirmed'
            ? (
              <Popconfirm title="冲销将把盘盈/盘亏调整反向应用回库存；确认？" onConfirm={() => voidRow(r.id)}>
                <Button size="small" danger loading={acting === r.id}>冲销</Button>
              </Popconfirm>
            )
            : <Text type="secondary" style={{ fontSize: 12 }}>已冲销</Text>
      ),
    },
  ]
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={openCreate}>+ 新建盘点单</Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>盘点→差异→确认校准库存（盘盈/盘亏全程留痕）</Text>
      </div>
      <Table<Stocktake> rowKey="id" size="small" loading={loading} columns={columns} dataSource={rows}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description="暂无盘点单" /> }} />
      <Modal title="新建盘点单" open={open} onCancel={() => setOpen(false)} onOk={create} confirmLoading={creating} okText="建档（草稿）" width={520}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>选择库存行（SKU × 批次）</Text>
            <Select style={{ width: '100%' }} value={invKey} onChange={setInvKey} placeholder="选择要盘点的库存行" showSearch optionFilterProp="label"
              options={invs.map((i) => ({ value: i.id, label: `${i.productName} · ${i.batchNo}（账面 ${i.quantity}）` }))} />
          </div>
          {cur && (
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="账面数">{cur.quantity}</Descriptions.Item>
              <Descriptions.Item label="安全库存">{cur.safetyStock}</Descriptions.Item>
            </Descriptions>
          )}
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>实盘数</Text>
            <InputNumber style={{ width: '100%' }} min={0} value={actualQty} onChange={(v) => setActualQty(v as number | undefined)} placeholder="实盘清点数量" />
          </div>
        </Space>
      </Modal>
    </div>
  )
}

export default WarehousePage
