import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, DatePicker, Form, Input, InputNumber,
  Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { PRODUCT_TYPE_LABEL, SETTLEMENT_LABEL, STATUS_LABEL } from '../lib/labels'
import type { Customer, Order, OrderLine, PlanSheet, Product } from '../lib/types'
import PackComboEditor from '../components/PackComboEditor'
import OrderDetailModal from '../components/OrderDetailModal'
import AiOrderImport from '../components/AiOrderImport'
import type { AiFillPayload, AiResolveResult } from '../components/AiOrderImport'

const SETTLEMENT_OPTIONS = Object.entries(SETTLEMENT_LABEL).map(([value, label]) => ({ value, label }))
const PRODUCT_TYPE_OPTIONS = Object.entries(PRODUCT_TYPE_LABEL).map(([value, label]) => ({ value, label }))

const { Text } = Typography

// ---------- AI 学习反馈：失败本地暂存，随下次成功自动补传（P0 修复，不再静默丢） ----------
const FEEDBACK_QUEUE_KEY = 'fms_ai_feedback_queue'
type QueuedFeedback = { payload: unknown; ts: number }

/** 上报失败 → 入 localStorage 队列（上限 50 条，尽力而为） */
function queueFeedback(payload: unknown) {
  try {
    const q: QueuedFeedback[] = JSON.parse(localStorage.getItem(FEEDBACK_QUEUE_KEY) || '[]')
    q.push({ payload, ts: Date.now() })
    localStorage.setItem(FEEDBACK_QUEUE_KEY, JSON.stringify(q.slice(-50)))
  } catch { /* localStorage 不可用时丢弃（尽力而为） */ }
}

/** 补传积压反馈；返回仍失败的条数（0 = 全部送达） */
async function flushFeedbackQueue(): Promise<number> {
  let q: QueuedFeedback[] = []
  try { q = JSON.parse(localStorage.getItem(FEEDBACK_QUEUE_KEY) || '[]') } catch { q = [] }
  if (!q.length) return 0
  const remain: QueuedFeedback[] = []
  for (const it of q) {
    try {
      await api('/ai/feedback', { method: 'POST', body: it.payload })
    } catch {
      remain.push(it)
    }
  }
  try { localStorage.setItem(FEEDBACK_QUEUE_KEY, JSON.stringify(remain.slice(-50))) } catch { /* ignore */ }
  return remain.length
}

/** 订单页：新建（一单多产品+复合包装） / 订单列表（筛选+详情+编辑） / 归档（已完成反查） */
export default function OrdersPage() {
  // 编辑闭环（I05 补）：订单列表「编辑」→ 跳转新建 Tab 预填为编辑模式 → 保存(PATCH)后回列表刷新
  const [tab, setTab] = useState('new')
  const [editOrder, setEditOrder] = useState<Order | null>(null)
  const [listTick, setListTick] = useState(0)
  // 进入订单页：自动补传积压的 AI 学习反馈（P0；静默，失败留待下次）
  useEffect(() => { void flushFeedbackQueue().catch(() => {}) }, [])
  function startEdit(o: Order) {
    setEditOrder(o)
    setTab('new')
  }
  function cancelEdit() {
    setEditOrder(null)
    setTab('list')
  }
  function onEdited() {
    setEditOrder(null)
    setListTick((t) => t + 1)
    setTab('list')
  }
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>订单</Typography.Title>
      <Tabs
        activeKey={tab} onChange={setTab}
        items={[
          { key: 'new', label: '+ 新建订单', children: <OrderCreateCard editOrder={editOrder} onEdited={onEdited} onCancelEdit={cancelEdit} /> },
          { key: 'list', label: '订单列表', children: <OrderListTable archived={false} refreshTick={listTick} onEdit={startEdit} /> },
          { key: 'archive', label: '归档（已完成）', children: <OrderListTable archived /> },
        ]}
      />
    </div>
  )
}

/** 新建/编辑订单：单头 + 多产品行（行含刻字/复合包装）；承接 AI 导入草稿（未建档客户/产品快速建档） */
function OrderCreateCard({ editOrder, onEdited, onCancelEdit }: {
  editOrder: Order | null
  onEdited: () => void
  onCancelEdit: () => void
}) {
  const editing = !!editOrder
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<Customer[]>('/customers').then(setCustomers).catch(() => {})
    api<Product[]>('/products').then(setProducts).catch(() => {})
  }, [])

  // 编辑模式（I05 驳回重做闭环）：外部选定草稿订单 → 整单载入表单
  useEffect(() => {
    if (!editOrder) return
    form.setFieldsValue({
      customerId: editOrder.customerId,
      poNo: editOrder.poNo || undefined,
      dueDate: editOrder.dueDate ? dayjs(editOrder.dueDate) : undefined,
      note: editOrder.note || undefined,
      lines: editOrder.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        currency: l.currency,
        engraving: l.engraving || undefined,
        packaging: (l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined),
      })),
    })
    setPending(null)
    setImportTexts({})
  }, [editOrder]) // eslint-disable-line react-hooks/exhaustive-deps

  // 临时诊断挂载：暴露 form 实例便于 headless 回归读真实 store（保留可随时移除）
  useEffect(() => {
    ;(window as unknown as { __orderForm?: typeof form }).__orderForm = form
  }, [form])

  const defaultLine: OrderLine = {
    productId: undefined as unknown as number,
    quantity: 1000,
    unitPrice: 3.5,
    currency: 'RMB',
  }

  // ===== AI 导入承接：未建档客户/产品文本 → 快速建档（检测在建单前完成） =====
  // 客户未建档：pending.customer 文本；产品未建档：importTexts（行 name → 识别文本）。
  // 识别文本不进 Form store（无对应 Form.Item，setFieldsValue 数组路径会丢），用组件 state 承载。
  const [pending, setPending] = useState<{ customer?: string; parsed?: AiResolveResult } | null>(null)
  const [importTexts, setImportTexts] = useState<Record<number, string>>({})
  const watchLines = Form.useWatch('lines', form) as Array<OrderLine & { productName?: string }> | undefined
  const watchCustomerId = Form.useWatch('customerId', form)

  // 用户在档案里选了客户 → 「未建档客户」提示自动消失
  useEffect(() => {
    if (watchCustomerId && pending?.customer) {
      setPending((p) => (p ? { ...p, customer: undefined } : p))
    }
  }, [watchCustomerId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 仍未建档/未选的未建档产品文本（行 productId 仍空才计） */
  function liveUnmatchedTexts(): string[] {
    return Object.entries(importTexts)
      .filter(([name]) => !form.getFieldValue(['lines', Number(name), 'productId']))
      .map(([, text]) => text)
  }
  /** 行已建档/改选 → 移除该行的未建档标记 */
  function clearImportText(name: number) {
    setImportTexts((p) => {
      if (!(name in p)) return p
      const q = { ...p }; delete q[name]; return q
    })
  }
  /** 删除行：Form.List remove 后行 name 前移，同步平移 importTexts */
  function deleteLine(remove: (i: number) => void, name: number) {
    remove(name)
    setImportTexts((p) => {
      const q: Record<number, string> = {}
      for (const [k, v] of Object.entries(p)) {
        const n = Number(k)
        q[n === name ? -1 : n > name ? n - 1 : n] = v
      }
      delete q[-1]
      return q
    })
  }

  /** AI 复核确认回调：按识别结果预填表单；未建档项带文本提示建档 */
  function fillFromAI(p: AiFillPayload) {
    form.setFieldsValue({
      customerId: p.customerId ?? undefined,
      poNo: p.poNo || undefined,
      dueDate: p.dueDate ? dayjs(p.dueDate) : undefined,
      note: p.note || undefined,
      lines: p.lines.map((l) => ({
        productId: l.productId ?? undefined,
        quantity: l.quantity ?? undefined,
        unitPrice: l.unitPrice ?? undefined,
        currency: l.currency ?? 'RMB',
        engraving: l.engraving,
        packaging: l.packaging,
      })),
    })
    const texts: Record<number, string> = {}
    p.lines.forEach((l, i) => { if (l.productName && !l.productId) texts[i] = l.productName })
    setImportTexts(texts)
    setPending({ customer: p.customerText, parsed: p.result })
    message.success('AI 草稿已填入下方新建订单表单：核对后处理「未建档」项再保存')
  }

  // 调试挂载：headless 回归模拟 AI 填入（随时可移除）
  useEffect(() => {
    ;(window as unknown as { __fillAI?: (p: AiFillPayload) => void }).__fillAI = fillFromAI
  })

  // ---- 快速客户建档 ----
  const [custQuickOpen, setCustQuickOpen] = useState(false)
  const [custQuickSaving, setCustQuickSaving] = useState(false)
  const [custQuickName, setCustQuickName] = useState('')
  const [custQuickSettle, setCustQuickSettle] = useState<string | undefined>()
  async function submitQuickCustomer() {
    const name = custQuickName.trim()
    if (!name) { message.warning('请填写客户名称'); return }
    setCustQuickSaving(true)
    try {
      const row = await api<Customer>('/customers', { method: 'POST', body: { name, settlement: custQuickSettle || undefined } })
      setCustomers((cs) => [...cs, row])
      form.setFieldValue('customerId', row.id)
      setPending((p) => (p ? { ...p, customer: undefined } : p))
      message.success(`客户「${name}」已建档并自动选用`)
      setCustQuickOpen(false); setCustQuickName('')
    } catch (e) {
      message.error('建档失败：' + (e as Error).message)
    } finally { setCustQuickSaving(false) }
  }

  // ---- 快速产品建档 ----
  const [prodQuick, setProdQuick] = useState<{ name: number; text: string } | null>(null) // 待建档产品（行号+识别文本）
  const [prodQuickSaving, setProdQuickSaving] = useState(false)
  const [prodQuickType, setProdQuickType] = useState('uk_acetylene')
  async function submitQuickProduct() {
    if (!prodQuick) return
    const name = prodQuick.text.trim()
    setProdQuickSaving(true)
    try {
      const row = await api<Product>('/products', { method: 'POST', body: { name, type: prodQuickType, safetyStock: 0 } })
      setProducts((ps) => [...ps, row])
      // 回填该识别文本对应的行（行号仍有效则自动选中）
      if (importTexts[prodQuick.name] === prodQuick.text) {
        form.setFieldValue(['lines', prodQuick.name, 'productId'], row.id)
        clearImportText(prodQuick.name)
        message.success(`产品「${name}」已加入目录并填入行`)
      } else {
        message.success(`产品「${name}」已加入目录，请回到对应行手动选择`)
      }
      setProdQuick(null)
    } catch (e) {
      message.error('建档失败：' + (e as Error).message)
    } finally { setProdQuickSaving(false) }
  }

  async function handleSave() {
    // 检测：AI 带来的未建档项必须先建档/改选，否则 FK 无法落库
    const pendingTexts = liveUnmatchedTexts()
    if (pendingTexts.length) {
      message.warning(`仍有 ${pendingTexts.length} 个产品行未建档或未选择（${pendingTexts.map((t) => `「${t}」`).join('、')}）：请点上方「加入产品目录」或从目录改选`)
      return
    }
    if (pending?.customer) {
      message.warning(`客户「${pending.customer}」不在档案：请点「快速客户建档」或从档案选择`)
      return
    }
    const values = await form.validateFields()
    // 行校验：产品必选、数量/单价为正
    const lines = (values.lines ?? []).filter((l: OrderLine) => l.productId)
    if (!lines.length) { message.warning('至少加一个产品行'); return }
    const body = {
      customerId: values.customerId,
      poNo: values.poNo,
      // 纯日期字段：不能用 toISOString()（东八区会被 UTC 化提前一天），按本地日历日格式化
      dueDate: dayjs(values.dueDate).format('YYYY-MM-DD'),
      note: values.note,
      lines: lines.map((l: OrderLine) => ({
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        currency: l.currency,
        engraving: l.engraving || undefined,
        packaging: (l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined),
      })),
    }
    setSaving(true)
    try {
      if (editing && editOrder) {
        const updated = await api<Order>(`/orders/${editOrder.id}`, { method: 'PATCH', body })
        message.success(`订单 ${updated.orderNo} 已更新（草稿）—— 重新「确认」即生成新计划单`)
        form.resetFields()
        setPending(null)
        setImportTexts({})
        onEdited()
        return
      }
      const created = await api<Order>('/orders', {
        method: 'POST',
        body,
      })
      // 建单成功：清除 AI 单槽草稿 + 学习反馈（真实最终稿回流；失败本地暂存待重试，不再静默丢）
      api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
      if (pending?.parsed) {
        const feedback = {
          source: 'ai_import',
          parsed: pending.parsed,
          corrected: {
            customerId: values.customerId,
            poNo: values.poNo,
            dueDate: dayjs(values.dueDate).format('YYYY-MM-DD'),
            note: values.note,
            lines: lines.map((l: OrderLine) => ({
              productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
              currency: l.currency, engraving: l.engraving || undefined,
              packaging: (l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined),
            })),
          },
          directPass: pending.parsed.directPass,
        }
        api('/ai/feedback', { method: 'POST', body: feedback })
          .then(() => { void flushFeedbackQueue().catch(() => {}) }) // 本次送达后顺带补传积压
          .catch(() => {
            queueFeedback(feedback)
            message.warning('AI 学习反馈暂未送达，已本地保存、下次自动重试')
          })
      } else {
        void flushFeedbackQueue().catch(() => {}) // 手工建单也顺带清积压
      }
      message.success(`订单已保存为草稿：${created.orderNo}（可到「订单列表」确认生成计划单）`)
      form.resetFields()
      setPending(null)
      setImportTexts({})
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally { setSaving(false) }
  }

  // 行字段的"显式默认"，确保 mount 即写入 store（@rc-component/form 1.8.6
  // 对 Form.List initialValue 的传播有边界条件，由单元格 Form.Item 兜底更稳）
  const lineDefaults = useMemo(() => ({
    quantity: 1000,
    unitPrice: 3.5,
    currency: 'RMB',
  }), [])

  // 卡片展示用：仍为空的未建档产品（行号+文本）
  const unmatchedEntries = Object.entries(importTexts)
    .filter(([name]) => !(watchLines ?? [])[Number(name)]?.productId)

  // 列定义：以 record（Form.List 字段对象）定位行，避免 index 漂移导致 cell unmount。
  // 删除按钮的 remove 由 Form.List children 闭包传入
  const lineColumns = (remove: (i: number) => void): ColumnsType<{ name: number; key: number }> => [
    {
      title: '产品（目录）',
      width: 240,
      render: (_: unknown, record: { name: number; key: number }) => {
        const text = importTexts[record.name]
        const unmatched = !!text
        return (
          <Form.Item key={`${record.key}-productId`} name={[record.name, 'productId']}
            rules={[{ required: true, message: unmatched ? `「${text}」未建档：请建档或从目录选择` : '必选产品' }]}
            style={{ marginBottom: 0 }}>
            <Select placeholder={unmatched ? `⚠ ${text}（未建档，见上方提示）` : '选择产品'}
              showSearch optionFilterProp="label" status={unmatched ? 'error' : undefined}
              options={products.map((p) => ({ value: p.id, label: `${p.name}（${PRODUCT_TYPE_LABEL[p.type]}）` }))} />
          </Form.Item>
        )
      },
    },
    {
      title: '数量', width: 110,
      render: (_: unknown, record: { name: number; key: number }) => (
        <Form.Item key={`${record.key}-quantity`} name={[record.name, 'quantity']}
          initialValue={lineDefaults.quantity}
          rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 0 }}>
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '单价', width: 100,
      render: (_: unknown, record: { name: number; key: number }) => (
        <Form.Item key={`${record.key}-unitPrice`} name={[record.name, 'unitPrice']}
          initialValue={lineDefaults.unitPrice}
          rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 0 }}>
          <InputNumber min={0} precision={2} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '币种', width: 80,
      render: (_: unknown, record: { name: number; key: number }) => (
        <Form.Item key={`${record.key}-currency`} name={[record.name, 'currency']}
          initialValue={lineDefaults.currency} style={{ marginBottom: 0 }}>
          <Select options={[{ value: 'RMB', label: 'RMB' }, { value: 'USD', label: 'USD' }]} />
        </Form.Item>
      ),
    },
    {
      title: '刻字需求', width: 160,
      render: (_: unknown, record: { name: number; key: number }) => (
        <Form.Item key={`${record.key}-engraving`} name={[record.name, 'engraving']}
          style={{ marginBottom: 0 }}>
          <Input placeholder="如 LOGO/型号/批次 ✒" />
        </Form.Item>
      ),
    },
    {
      title: '包装要求（可多选）',
      render: (_: unknown, record: { name: number; key: number }) => (
        <Form.Item key={`${record.key}-packaging`} name={[record.name, 'packaging']}
          style={{ marginBottom: 0 }}>
          <PackComboEditor />
        </Form.Item>
      ),
    },
    {
      title: '', width: 48,
      render: (_: unknown, record: { name: number; key: number }) => (
        <Button type="text" danger size="small" onClick={() => deleteLine(remove, record.name)}>删</Button>
      ),
    },
  ]

  return (
    <Card title={editing && editOrder ? `编辑订单 ${editOrder.orderNo}` : '新建订单'}
      extra={editing ? (
        <Button size="small" onClick={onCancelEdit}>返回列表（取消编辑）</Button>
      ) : (
        <Typography.Text type="secondary">保存即草稿；确认生成计划单为 I05 动作</Typography.Text>
      )}>
      {!editing && <AiOrderImport onReviewDone={fillFromAI} />}

      {(pending?.customer || unmatchedEntries.length > 0) && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message={`AI 识别出 ${[pending?.customer ? '客户 1 个' : '', unmatchedEntries.length ? `产品 ${unmatchedEntries.length} 个` : ''].filter(Boolean).join('、')} 不在档案 —— 建档后自动填入本单（也可直接在表单改选，保存前会检测）`}
          description={(
            <Space direction="vertical" size={6} style={{ marginTop: 6, width: '100%' }}>
              {pending?.customer && (
                <Space size={8} wrap>
                  <Text strong style={{ color: '#d46b08' }}>客户：{pending.customer}</Text>
                  <Button size="small" type="primary" onClick={() => { setCustQuickName(pending.customer ?? ''); setCustQuickOpen(true) }}>快速客户建档</Button>
                </Space>
              )}
              {unmatchedEntries.map(([name, text]) => (
                <Space key={name} size={8} wrap>
                  <Text strong style={{ color: '#d46b08' }}>产品：{text}</Text>
                  <Button size="small" type="primary" onClick={() => { setProdQuick({ name: Number(name), text }); setProdQuickType('uk_acetylene') }}>加入产品目录</Button>
                </Space>
              ))}
            </Space>
          )}
        />
      )}

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
                rowKey={(record) => String((record as { key: number }).key)}
                pagination={false}
                size="small"
                style={{ marginTop: 8, marginBottom: 8 }}
                columns={lineColumns(remove)}
                dataSource={fields}
                locale={{ emptyText: '暂无行' }}
              />
              <Space>
                <Button onClick={() => add({ ...defaultLine })}>+ 加一行</Button>
                <Button type="primary" loading={saving} onClick={handleSave}>{editing ? '保存修改' : '保存订单（草稿）'}</Button>
              </Space>
            </>
          )}
        </Form.List>
      </Form>

      {/* 快速客户建档：AI 识别客户不在档案时一键建档并选用 */}
      <Modal title="快速客户建档（AI 识别客户不在档案）" open={custQuickOpen}
        onCancel={() => setCustQuickOpen(false)}
        onOk={submitQuickCustomer} okText="建档并选用" confirmLoading={custQuickSaving} width={420}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>客户名称 *</div>
            <Input value={custQuickName} onChange={(e) => setCustQuickName(e.target.value)} placeholder="AI 识别名，可修正" />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>结算方式</div>
            <Select style={{ width: '100%' }} allowClear placeholder="选填（默认现结）" value={custQuickSettle}
              onChange={setCustQuickSettle} options={SETTLEMENT_OPTIONS} />
          </div>
        </Space>
      </Modal>

      {/* 快速产品建档：AI 识别产品不在目录时一键建档并填入行 */}
      <Modal title="快速产品建档（AI 识别产品不在目录）" open={!!prodQuick}
        onCancel={() => setProdQuick(null)}
        onOk={submitQuickProduct} okText="加入目录并填入行" confirmLoading={prodQuickSaving} width={460}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>产品名称（沿用 AI 识别名）</div>
            <Input value={prodQuick?.text ?? ''} disabled />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>制式类型 *（影响后续工序路线/排期）</div>
            <Select style={{ width: '100%' }} value={prodQuickType} onChange={setProdQuickType}
              options={PRODUCT_TYPE_OPTIONS} />
          </div>
        </Space>
      </Modal>
    </Card>
  )
}

/** 订单列表 / 归档（archived=已完成）；draft 行提供 编辑/确认（I05 驳回重做闭环） */
function OrderListTable({ archived, refreshTick, onEdit }: {
  archived: boolean
  refreshTick?: number
  onEdit?: (o: Order) => void
}) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [rows, setRows] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [customerId, setCustomerId] = useState<number | undefined>()
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<Order | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  async function doDelete(r: Order) {
    setDeletingId(r.id)
    try {
      await api(`/orders/${r.id}`, { method: 'DELETE' })
      message.success(`已删除草稿订单 ${r.orderNo}`)
      fetchRows()
    } catch (e) {
      message.error('删除失败：' + (e as Error).message)
    } finally { setDeletingId(null) }
  }

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
  useEffect(() => { fetchRows() }, [archived, status, customerId, refreshTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const columns: ColumnsType<Order> = useMemo(() => [
    { title: '订单号', dataIndex: 'orderNo', width: 170, render: (v: string) => <Text strong>{v}</Text> },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    { title: 'PO号', dataIndex: 'poNo', width: 110, render: (v?: string | null) => v || '—' },
    {
      title: '总额(元)', width: 120, align: 'right',
      render: (_: unknown, r: Order) => (
        <Text strong>{r.totalAmount != null ? r.totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</Text>
      ),
    },
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
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('YYYY-MM-DD HH:mm')}</Text> : '—') },
    {
      title: '操作', width: 300,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'draft' && (
            <>
              {onEdit && <Button size="small" onClick={() => onEdit(r)}>编辑</Button>}
              <Button type="primary" size="small" loading={confirmingId === r.id} onClick={() => doConfirm(r)}>确认</Button>
              <Popconfirm
                title={`删除草稿订单 ${r.orderNo}？`}
                description="整单（含产品行）将永久删除，不可恢复；确认过的订单不能删除。"
                okText="删除" okButtonProps={{ danger: true }} cancelText="取消"
                onConfirm={() => doDelete(r)}
              >
                <Button danger size="small" loading={deletingId === r.id}>删除</Button>
              </Popconfirm>
            </>
          )}
          <Button size="small" onClick={() => setDetail(r)}>详情</Button>
        </Space>
      ),
    },
  ], [confirmingId, deletingId])

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
      <OrderDetailModal order={detail} open={!!detail} onClose={() => setDetail(null)} />
    </Card>
  )
}
