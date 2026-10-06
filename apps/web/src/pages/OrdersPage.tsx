import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, DatePicker, Form, Input, InputNumber,
  Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message,
  type TableProps,
} from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { SortOrder } from 'antd/es/table/interface'
import dayjs from 'dayjs'
import { api, loadOptions } from '../lib/api'
import { CURRENCY_LABEL, CURRENCY_OPTIONS, INVOICE_STATE_COLOR, INVOICE_STATE_LABEL, PENDING_CODE, PRODUCT_TYPE_LABEL, SETTLEMENT_LABEL, STATUS_LABEL } from '../lib/labels'
import { optionLabel, optionsPath, ORDER_PLACEHOLDER_HINT, useShowPlaceholders } from '../lib/placeholders'
import { fmtCents, toCents } from '../lib/money'
import type { Customer, Order, OrderLine, PlanSheet, Product } from '../lib/types'
import PackComboEditor from '../components/PackComboEditor'
import OrderDetailModal from '../components/OrderDetailModal'
import DraftFillModal from '../components/DraftFillModal'
import AiOrderImport from '../components/AiOrderImport'
import InvoiceFormModal from '../components/InvoiceFormModal'
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
  // 甲方裁定 2（2026-10-05）：建档下拉**始终**显示两个占位档案，**不受**「显示占位档案」开关影响 ——
  // 目的是让人工把订单/行**改指**到正确的客户或产品，或保留占位以维持待补状态。
  useEffect(() => {
    loadOptions<Customer>(optionsPath('/customers'), setCustomers, '客户档案')
    loadOptions<Product>(optionsPath('/products'), setProducts, '产品目录')
  }, [])

  // 编辑模式（I05 驳回重做闭环）：外部选定草稿订单 → 整单载入表单
  useEffect(() => {
    if (!editOrder) return
    form.setFieldsValue({
      customerId: editOrder.customerId,
      poNo: editOrder.poNo || undefined,
      // 交期待定的识单草稿：不要把哨兵日 2099-12-31 预填成真实交期，留空让人工选
      dueDate: editOrder.dueDate && !editOrder.dueDateTbd ? dayjs(editOrder.dueDate) : undefined,
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
    // 币种统一归一为 CNY（I17 甲方裁定）
    currency: 'CNY',
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
        currency: l.currency ?? 'CNY',
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
    currency: 'CNY',
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
              options={products.map((p) => ({ value: p.id, label: `${optionLabel(p.name)}（${PRODUCT_TYPE_LABEL[p.type]}）` }))} />
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
          <Select options={CURRENCY_OPTIONS} />
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
        <Typography.Text type="secondary">保存后为草稿；确认后自动生成计划单</Typography.Text>
      )}>
      {!editing && <AiOrderImport onReviewDone={fillFromAI} onDraftCreated={onEdited} />}

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
              options={customers.map((c) => ({ value: c.id, label: optionLabel(c.name) }))} />
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

// =====================================================================================
// 产品行展示（布局重做）：列表只给「紧凑摘要」，明细收进 AntD 展开行
// -------------------------------------------------------------------------------------
// 旧版把一单的全部 order_lines 平铺在同一个单元格里：多产品时该格被撑成多行、
// 行高参差，且其它列被挤压换行，极难读。
// 新版：
//   · 折叠态 = 「N 个产品」+ 首个产品名 × 数量 + 「等 M 项」（悬停看其余产品）+ 行级待补汇总；
//   · 展开态 = 该单产品明细小表格（产品名 / 数量 / 单价 / 金额 / 待补标记），默认收起；
//   · 待补语义沿用后端 PENDING_CODE：缺价/缺数量 的格子用醒目的红色「待补」占位，
//     而不是显示 0（0 是「原始单据没识别到」的落库占位，直接显示会误导）。
// =====================================================================================

/** 行级待补：按 code 取中文诊断（无此项 → undefined） */
function linePendingMsg(line: OrderLine, code: string): string | undefined {
  return (line.pendingItems ?? []).find((x) => x.code === code)?.message
}

/** 数量展示（千分位；缺数量时另标「待补」） */
function fmtQty(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—'
}

/** 产品行显示名：已建档取目录名，未建档回落到识别原文 */
function lineName(line: OrderLine): string {
  return line.productName || line.productNameText || `产品#${line.productId}`
}

/** 币种展示（甲方裁定统一归一为 CNY：历史 RMB 行按 CNY 展示） */
function lineCurrency(line: OrderLine): string {
  return CURRENCY_LABEL[line.currency] ?? line.currency
}

/** 行金额（分）：数量或单价待补时返回 null（不可计价，界面显示 —） */
function lineAmountCents(line: OrderLine): number | null {
  if (linePendingMsg(line, PENDING_CODE.QUANTITY_MISSING) || linePendingMsg(line, PENDING_CODE.PRICE_MISSING)) return null
  return toCents(line.quantity * line.unitPrice)
}

/** 待补小标签（悬停出中文诊断；无待补机制的行不显示） */
function PendingTag({ items }: { items: OrderLine['pendingItems'] }) {
  if (!Array.isArray(items)) return <Text type="secondary">—</Text>
  if (!items.length) return <Tag color="success" style={{ marginInlineEnd: 0 }}>已补全</Tag>
  return (
    <Tooltip title={<div style={{ maxWidth: 460 }}>{items.map((x, i) => <div key={i}>· {x.message}</div>)}</div>}>
      <Tag color="error" style={{ marginInlineEnd: 0, cursor: 'help' }}>待补 {items.length} 项</Tag>
    </Tooltip>
  )
}

/**
 * 「占位产品行」计数：该订单里指向占位产品档案（未建档）的行数。
 * 甲方裁定 2026-10-05（口径收窄「只看客户」）：这类订单**不再隐藏**，改为在单据上加醒目标记，
 * 判定沿用后端待补编码 product_not_filed（message 由后端给，前端只按 code 定位）。
 */
function placeholderProductLineCount(order: Order): number {
  return (order.lines ?? []).filter((l) => !!linePendingMsg(l, PENDING_CODE.PRODUCT_NOT_FILED)).length
}

/** 折叠态摘要：N 个产品 + 首个产品（名 × 数量）+ 等 M 项 + 行级待补汇总；单行不换行、超长省略 */
function OrderLinesSummary({ order }: { order: Order }) {
  const lines = order.lines ?? []
  if (!lines.length) return <Text type="secondary">无产品行</Text>
  const first = lines[0]
  const rest = lines.slice(1)
  const firstName = lineName(first)
  const qtyMissing = !!linePendingMsg(first, PENDING_CODE.QUANTITY_MISSING)
  const firstText = `${firstName} × ${qtyMissing ? '待补' : fmtQty(first.quantity)}`
  const unfiledCount = placeholderProductLineCount(order)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, whiteSpace: 'nowrap' }}>
      <Tag color="blue" style={{ marginInlineEnd: 0 }}>{lines.length} 个产品</Tag>
      {/* 占位产品行：不再隐藏单据，改为醒目标记（红色 + 悬停说明怎么补） */}
      {unfiledCount > 0 && (
        <Tooltip title={`本单有 ${unfiledCount} 行产品未建档（挂在占位产品档案「（未建档产品·待补）」下，识别原文已留痕）。`
          + '该单据不再被隐藏：展开「产品明细」看原文，或点右侧「补全」建档 / 改指到真实产品。'}>
          <Tag color="error" style={{ marginInlineEnd: 0, cursor: 'help', fontWeight: 600 }}>
            未建档产品行 {unfiledCount}
          </Tag>
        </Tooltip>
      )}
      <Tooltip title={firstText}>
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{firstText}</span>
      </Tooltip>
      {rest.length > 0 && (
        <Tooltip title={<div style={{ maxWidth: 460 }}>{rest.map((l, i) => <div key={i}>· {lineName(l)} × {fmtQty(l.quantity)}</div>)}</div>}>
          <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>等 {rest.length} 项</Text>
        </Tooltip>
      )}
    </div>
  )
}

/** 展开态：该订单的产品明细小表格（产品名 / 数量 / 单价 / 金额 / 待补标记） */
function OrderLinesDetail({ order }: { order: Order }) {
  const lines = order.lines ?? []
  const priceable = lines.filter((l) => lineAmountCents(l) != null)
  const totalCents = priceable.reduce((sum, l) => sum + (lineAmountCents(l) ?? 0), 0)
  const pendingLines = lines.filter((l) => (l.pendingItems?.length ?? 0) > 0).length
  const columns: ColumnsType<OrderLine> = [
    {
      title: '产品名', dataIndex: 'productName',
      render: (_: unknown, l: OrderLine) => {
        const name = lineName(l)
        const unfiled = linePendingMsg(l, PENDING_CODE.PRODUCT_NOT_FILED)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Tooltip title={name}>
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            </Tooltip>
            {unfiled && <Tooltip title={unfiled}><Tag color="error" style={{ marginInlineEnd: 0, cursor: 'help' }}>未建档</Tag></Tooltip>}
            {l.engraving && <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>✒{l.engraving}</Text>}
          </div>
        )
      },
    },
    {
      title: '数量', width: 110, align: 'right',
      render: (_: unknown, l: OrderLine) => {
        const miss = linePendingMsg(l, PENDING_CODE.QUANTITY_MISSING)
        return miss
          ? <Tooltip title={miss}><Text type="danger" strong style={{ cursor: 'help' }}>待补</Text></Tooltip>
          : <Text>{fmtQty(l.quantity)}</Text>
      },
    },
    {
      title: '单价', width: 150, align: 'right',
      render: (_: unknown, l: OrderLine) => {
        const miss = linePendingMsg(l, PENDING_CODE.PRICE_MISSING)
        if (miss) return <Tooltip title={miss}><Text type="danger" strong style={{ cursor: 'help' }}>待补</Text></Tooltip>
        return (
          <Space size={4}>
            <Text>{l.unitPrice.toFixed(2)}</Text>
            {lineCurrency(l) !== 'CNY' && <Text type="secondary" style={{ fontSize: 12 }}>{lineCurrency(l)}</Text>}
            {l.priceSource === 'quote' && (
              <Tooltip title="单价由报价记录自动补全（来源可追溯）"><Tag color="cyan" style={{ marginInlineEnd: 0, cursor: 'help' }}>报价</Tag></Tooltip>
            )}
          </Space>
        )
      },
    },
    {
      title: '金额', width: 150, align: 'right',
      render: (_: unknown, l: OrderLine) => {
        const cents = lineAmountCents(l)
        if (cents == null) {
          return <Tooltip title="该行数量或单价尚未补全，暂不参与计价"><Text type="secondary" style={{ cursor: 'help' }}>—</Text></Tooltip>
        }
        return <Text strong>{fmtCents(cents)}</Text>
      },
    },
    {
      title: '待补标记', width: 130,
      render: (_: unknown, l: OrderLine) => <PendingTag items={l.pendingItems} />,
    },
  ]
  return (
    <div style={{ padding: '4px 8px 8px' }}>
      <Table<OrderLine>
        rowKey={(l, i) => String(l.id ?? `idx-${i}`)}
        size="small"
        pagination={false}
        columns={columns}
        dataSource={lines}
        locale={{ emptyText: '该订单暂无产品行' }}
        summary={lines.length ? () => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={3}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                合计：共 {lines.length} 行{priceable.length < lines.length ? `（${lines.length - priceable.length} 行因待补未计价）` : ''}
              </Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right">
              <Text strong>{fmtCents(totalCents)}</Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2}>
              {pendingLines > 0
                ? <Text type="danger" style={{ fontSize: 12 }}>{pendingLines} 行待补</Text>
                : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>}
            </Table.Summary.Cell>
          </Table.Summary.Row>
        ) : undefined}
      />
    </div>
  )
}

// =====================================================================================
// 订单列表排序（多列组合排序）
// -------------------------------------------------------------------------------------
// 口径与后端 apps/api/src/orders/order-sort.ts **一一对应**（字段白名单 / 优先级 / 默认值）：
//   · 默认排序 = 交期 DESC（后端缺省同此）。「交期待定」的哨兵日单据（2099-12-31 + due_date_tbd）
//     被后端当成「无交期」恒定排在最后 —— 前端不做二次排序，只信接口返回的顺序；
//   · 点击表头 = 把该列加入组合排序（**新列优先级最低，排在末尾**），再点切换升/降序，
//     点第三次移除该列；全部移除后自动回到默认排序（交期 DESC）；
//   · 表头标题后的小数字 = 组合排序优先级（1 最先比较），与发给后端的
//     sort 参数（逗号分隔、从左到右）严格同序，用户一眼能看清「先按什么排、再按什么排」；
//   · 排序在后端完成（sorter 只配置 multiple、不配置 compare → AntD 不做本地排序），
//     以免出现「接口按交期排、界面按本地再排一遍」的两套口径。
// =====================================================================================
type OrderSortDir = 'asc' | 'desc'
type OrderSortField =
  | 'dueDate' | 'orderNo' | 'poNo' | 'customer' | 'status' | 'invoiceState'
  | 'amount' | 'invoiced' | 'pendingCount' | 'createdAt' | 'lineCount'

interface OrderSortKey { field: OrderSortField; dir: OrderSortDir }

/** 排序字段中文名（排序状态条 / 表头提示用），顺序 = 后端白名单顺序 */
const ORDER_SORT_LABEL: Record<OrderSortField, string> = {
  dueDate: '交期',
  orderNo: '订单号',
  poNo: '客户 PO 号',
  customer: '客户',
  status: '状态',
  invoiceState: '开票状态',
  amount: '订单金额',
  invoiced: '已开票金额',
  pendingCount: '待补项数量',
  createdAt: '创建时间',
  lineCount: '产品行数',
}

const ORDER_SORT_FIELDS = Object.keys(ORDER_SORT_LABEL) as OrderSortField[]

/** 默认排序：交期 DESC（与后端 sort 缺省一致） */
const DEFAULT_ORDER_SORT: OrderSortKey[] = [{ field: 'dueDate', dir: 'desc' }]

/** 是否默认排序（「重置排序」按钮的禁用条件） */
const isDefaultOrderSort = (keys: OrderSortKey[]) =>
  keys.length === 1 && keys[0].field === 'dueDate' && keys[0].dir === 'desc'

/** 表头标题 + 组合排序序号（1/2/3…）：序号 = 该列在组合排序中的优先级 */
function SortTitle({ text, order }: { text: string; order?: number }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {text}
      {order ? (
        // 用原生 title（而不是 AntD Tooltip）：表头本身已被 AntD 的排序提示 Tooltip 包裹，
        // 再嵌一层会出现两个浮层同时弹出
        <sup
          title={`组合排序优先级 ${order}：数字越小越先比较。再点表头切换升/降序，点第三次取消该列。`}
          style={{ marginLeft: 3, fontSize: 10, fontWeight: 700, color: '#1677ff', cursor: 'help' }}
        >
          {order}
        </sup>
      ) : null}
    </span>
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
  /**
   * 组合排序键（有序：下标 0 = 优先级最高）。
   * 默认 = 交期 DESC；顺序即发给后端的 sort 参数顺序，也是表头显示 1/2/3 的依据。
   */
  const [sortKeys, setSortKeys] = useState<OrderSortKey[]>(DEFAULT_ORDER_SORT)
  /** I17：只看「有未补全项的草稿单」（识单落草稿后缺价/缺交期/未建档的单据） */
  const [pendingOnly, setPendingOnly] = useState(false)
  /**
   * I17 裁定②「显示占位档案」开关（默认关闭）。
   * 2026-10-05 甲方裁定收窄口径：**只看客户** —— 关时只隐藏「客户是占位档案」的订单；
   * 「产品行挂占位产品」的订单照常显示（行上标待补 + 单据上红色「未建档产品行 N」标记）。
   */
  const [showPlaceholders, setShowPlaceholders] = useShowPlaceholders()
  const [fillFor, setFillFor] = useState<Order | null>(null)
  const [detail, setDetail] = useState<Order | null>(null)
  /** 快捷开票目标订单（带入剩余未开票金额；I16 交互简化） */
  const [invoiceFor, setInvoiceFor] = useState<Order | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [cancelingId, setCancelingId] = useState<number | null>(null)

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

  // 客户筛选下拉：与建档下拉同口径 —— **始终**含占位客户（甲方裁定 2），便于筛出挂在占位档案下的待补单
  useEffect(() => {
    loadOptions<Customer>(optionsPath('/customers'), setCustomers, '客户档案')
  }, [])

  async function fetchRows() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (archived) params.set('status', 'completed')
      else if (status) params.set('status', status)
      if (customerId) params.set('customerId', String(customerId))
      if (kw.trim()) params.set('kw', kw.trim())
      if (pendingOnly) params.set('hasPending', '1')
      // I17 裁定②（口径收窄「只看客户」）：默认只隐藏占位**客户**的单据；
      // 打开开关才带 includePlaceholders=1（连占位客户单一起显示，仅供排查）
      if (showPlaceholders) params.set('includePlaceholders', '1')
      // 组合排序：字段白名单与优先级由后端校验/执行（非法字段会 400 中文提示）
      if (sortKeys.length) params.set('sort', sortKeys.map((k) => `${k.field}:${k.dir}`).join(','))
      setRows(await api<Order[]>(`/orders?${params.toString()}`))
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally { setLoading(false) }
  }
  useEffect(() => { fetchRows() }, [archived, status, customerId, refreshTick, pendingOnly, showPlaceholders, sortKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 取消订单（五态收敛）：未投产可取消，未开工计划单与未核销应收同步冲销 */
  async function doCancel(r: Order) {
    setCancelingId(r.id)
    try {
      await api(`/orders/${r.id}/cancel`, { method: 'POST' })
      message.success(`订单 ${r.orderNo} 已取消`)
      fetchRows()
    } catch (e) { message.error((e as Error).message) }
    finally { setCancelingId(null) }
  }

  // ---- 组合排序：优先级 / 方向 / sorter.multiple ----
  /** 该字段在组合排序中的优先级（1 起；未参与 → undefined） */
  const sortIndex = (field: OrderSortField): number | undefined => {
    const i = sortKeys.findIndex((k) => k.field === field)
    return i < 0 ? undefined : i + 1
  }
  /** 受控排序方向（AntD 表头箭头） */
  const sortDirOf = (field: OrderSortField): SortOrder | null => {
    const k = sortKeys.find((x) => x.field === field)
    return k ? (k.dir === 'desc' ? 'descend' : 'ascend') : null
  }
  /**
   * sorter.multiple：参与组合排序 → 当前优先级；未参与 → 「加入后」的优先级。
   * 必须恒为数字（不能是 false/缺省），否则 AntD 会退回单列排序模式、点第二列会清掉第一列。
   * 这里只配置 multiple（不配 compare）→ AntD **不做本地排序**，排序一律由后端 sort 参数执行。
   */
  const sortMultiple = (field: OrderSortField): number => sortIndex(field) ?? sortKeys.length + 1

  /** 表头点击回调（AntD 受控排序）：维护「排序键 + 方向」，顺序 = 优先级顺序 */
  const handleTableChange: TableProps<Order>['onChange'] = (_pagination, _filters, sorter, extra) => {
    if (extra?.action !== 'sort') return
    const list = Array.isArray(sorter) ? sorter : [sorter]
    const active = new Map<OrderSortField, OrderSortDir>()
    for (const s of list) {
      const field = s?.columnKey as OrderSortField | undefined
      if (!s?.order || !field || !ORDER_SORT_FIELDS.includes(field)) continue
      active.set(field, s.order === 'descend' ? 'desc' : 'asc')
    }
    // ① 原有键保持相对优先级（只更新方向）；② 新加入的键追加到末尾（优先级最低）
    const next: OrderSortKey[] = []
    for (const k of sortKeys) {
      const dir = active.get(k.field)
      if (dir) next.push({ field: k.field, dir })
    }
    for (const field of ORDER_SORT_FIELDS) {
      const dir = active.get(field)
      if (dir && !next.some((k) => k.field === field)) next.push({ field, dir })
    }
    // 全部取消排序 → 回到默认（交期 DESC），列表永远有确定的顺序
    setSortKeys(next.length ? next : DEFAULT_ORDER_SORT)
  }

  const columns: ColumnsType<Order> = useMemo(() => [
    {
      title: <SortTitle text="订单号" order={sortIndex('orderNo')} />, dataIndex: 'orderNo', key: 'orderNo', width: 126, fixed: 'left',
      sorter: { multiple: sortMultiple('orderNo') }, sortOrder: sortDirOf('orderNo'),
      ellipsis: { showTitle: false }, render: (v: string) => <Tooltip title={v}><Text strong>{v}</Text></Tooltip>,
    },
    {
      // I18：PO 号紧贴订单号并纳入**左侧固定区**（左固定列必须从最左连续排列）——
      // 横向滚动核对开票/对账时，订单号与客户 PO 号始终同屏可见，不会一个滚走一个留下
      title: <SortTitle text="PO号" order={sortIndex('poNo')} />, dataIndex: 'poNo', key: 'poNo', width: 80, fixed: 'left',
      sorter: { multiple: sortMultiple('poNo') }, sortOrder: sortDirOf('poNo'),
      ellipsis: { showTitle: false },
      render: (v?: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : <Text type="secondary">—</Text>),
    },
    {
      title: <SortTitle text="客户" order={sortIndex('customer')} />, dataIndex: 'customerName', key: 'customer', width: 90,
      sorter: { multiple: sortMultiple('customer') }, sortOrder: sortDirOf('customer'),
      ellipsis: { showTitle: false },
      render: (v?: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : '—'),
    },
    // 开票三列（I16 交互简化）：价格 / 已开票 / 开票状态 —— 未开票余额仍在「详情」与开票弹窗中可见
    {
      title: <SortTitle text="价格(元)" order={sortIndex('amount')} />, key: 'amount', width: 88, align: 'right',
      sorter: { multiple: sortMultiple('amount') }, sortOrder: sortDirOf('amount'),
      render: (_: unknown, r: Order) => (
        <Text strong>{r.totalAmountCents != null
          ? fmtCents(r.totalAmountCents)
          : (r.totalAmount != null ? r.totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')}</Text>
      ),
    },
    {
      title: <SortTitle text="已开票(元)" order={sortIndex('invoiced')} />, key: 'invoiced', width: 84, align: 'right',
      sorter: { multiple: sortMultiple('invoiced') }, sortOrder: sortDirOf('invoiced'),
      render: (_: unknown, r: Order) => (
        r.invoicedCents
          ? <Text>{fmtCents(r.invoicedCents)}</Text>
          : <Text type="secondary">0.00</Text>
      ),
    },
    {
      title: <SortTitle text="开票状态" order={sortIndex('invoiceState')} />, key: 'invoiceState', width: 78,
      sorter: { multiple: sortMultiple('invoiceState') }, sortOrder: sortDirOf('invoiceState'),
      render: (_: unknown, r: Order) => {
        const state = r.invoiceState ?? (r.invoicedCents ? 'partial' : 'none')
        return <Tag color={INVOICE_STATE_COLOR[state]}>{INVOICE_STATE_LABEL[state] ?? state}</Tag>
      },
    },
    {
      // 折叠态只给摘要（详见 OrderLinesSummary）：多产品不再把单元格撑成多行
      title: <SortTitle text="产品摘要" order={sortIndex('lineCount')} />, key: 'lineCount', width: 268,
      sorter: { multiple: sortMultiple('lineCount') }, sortOrder: sortDirOf('lineCount'),
      render: (_: unknown, r: Order) => <OrderLinesSummary order={r} />,
    },
    {
      title: <SortTitle text="交期" order={sortIndex('dueDate')} />, dataIndex: 'dueDate', key: 'dueDate', width: 92,
      sorter: { multiple: sortMultiple('dueDate') }, sortOrder: sortDirOf('dueDate'),
      // 交期待定（I17）：库里的 due_date 是**哨兵日 2099-12-31**（orders.due_date 是 NOT NULL），
      // 界面只认 due_date_tbd=true → 显示「待定」，绝不把哨兵日当成真实交期展示/预填。
      render: (v: string, r: Order) => (r.dueDateTbd
        ? (
          <Tooltip title="交期待定：原始单据未识别到交货日期。因 orders.due_date 为 NOT NULL，系统用哨兵日 2099-12-31 占位并置 due_date_tbd=true；补填真实交期后该标记自动清除。">
            <Tag color="error" style={{ cursor: 'help' }}>待定</Tag>
          </Tooltip>
        )
        : dayjs(v).format('YYYY-MM-DD')),
    },
    {
      // I17 待补列：识单落草稿的单据在此一眼看出还缺什么（中文诊断，悬停看全部）
      title: <SortTitle text="待补" order={sortIndex('pendingCount')} />, key: 'pendingCount', width: 86,
      sorter: { multiple: sortMultiple('pendingCount') }, sortOrder: sortDirOf('pendingCount'),
      render: (_: unknown, r: Order) => {
        const items = r.pendingItems
        if (!Array.isArray(items)) return <Text type="secondary">—</Text>
        // 占位产品行提示（口径收窄后这类单据默认可见，用标记替代隐藏）
        const unfiled = placeholderProductLineCount(r)
        const unfiledTip = unfiled
          ? `含 ${unfiled} 行「未建档产品」占位行（可展开明细看识别原文，或点「补全」建档）`
          : null
        if (!items.length) {
          return unfiledTip
            ? <Tooltip title={unfiledTip}><Tag color="error" style={{ cursor: 'help' }}>未建档产品行</Tag></Tooltip>
            : <Tag color="success">已补全</Tag>
        }
        return (
          <Tooltip title={<div style={{ maxWidth: 420 }}>
            {items.map((x, i) => <div key={i}>· {x.message}</div>)}
            {unfiledTip && <div>· {unfiledTip}</div>}
          </div>}>
            <Tag color="error" style={{ cursor: 'help' }}>待补 {items.length} 项</Tag>
          </Tooltip>
        )
      },
    },
    {
      title: <SortTitle text="状态" order={sortIndex('status')} />, dataIndex: 'status', key: 'status', width: 62,
      sorter: { multiple: sortMultiple('status') }, sortOrder: sortDirOf('status'),
      render: (v: string) => <Tag color={v === 'completed' ? 'success' : v === 'draft' ? 'default' : 'processing'}>{STATUS_LABEL[v] ?? v}</Tag>,
    },
    {
      title: '录单人', dataIndex: 'operatorName', width: 62, ellipsis: { showTitle: false },
      render: (v?: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : <Text type="secondary">未绑定</Text>),
    },
    {
      // 创建时间（排序白名单字段）：同交期/同客户的单据靠它看出先后；默认排序的兜底键也是它
      title: <SortTitle text="创建时间" order={sortIndex('createdAt')} />, dataIndex: 'createdAt', key: 'createdAt', width: 88,
      sorter: { multiple: sortMultiple('createdAt') }, sortOrder: sortDirOf('createdAt'),
      ellipsis: { showTitle: false },
      render: (v?: string) => (v
        ? <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm')}><Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('YYYY-MM-DD')}</Text></Tooltip>
        : '—'),
    },
    {
      // 只显示到日：1920 一屏要放下 14 列 + 展开列，秒/分钟放进 Tooltip（悬停看完整时间）
      title: '更新时间', dataIndex: 'updatedAt', width: 88, ellipsis: { showTitle: false },
      render: (v?: string) => (v
        ? <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm')}><Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('YYYY-MM-DD')}</Text></Tooltip>
        : '—'),
    },
    {
      // 右侧固定：横向滚动时「操作」始终可见（宽表在窄屏下必然要滚动，绝不能把按钮滚出视野）
      // 448 = 7 个按钮（含「补全（N）」）单行不换行的实测宽度，保证各订单行行高一致
      title: '操作', width: 448, fixed: 'right',
      render: (_, r) => (
        <Space size={4} wrap>
          {r.status === 'draft' && (
            <>
              {!!r.pendingItems?.length && (
                <Button size="small" danger onClick={() => setFillFor(r)}>补全（{r.pendingItems.length}）</Button>
              )}
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
          {(r.status === 'draft' || r.status === 'confirmed') && (
            <Popconfirm
              title={`取消订单 ${r.orderNo}？`}
              description="未开工的计划单与未核销的应收会同步冲销；已报工/已出库的订单不能取消。"
              okText="取消订单" okButtonProps={{ danger: true }} cancelText="返回"
              onConfirm={() => doCancel(r)}
            >
              <Button danger size="small" loading={cancelingId === r.id}>取消订单</Button>
            </Popconfirm>
          )}
          {/* 快捷开票（I16）：带入该订单剩余未开票金额，点确定即结清；已开完默认阻止，需在「高级」勾选允许超开 */}
          <Button
            size="small" type="primary" ghost
            title={r.invoiceState === 'done'
              ? '该订单已开完票：默认阻止继续开票，如确需超开请在弹窗「高级」里勾选「允许超开」'
              : '按剩余未开票金额开票'}
            onClick={() => setInvoiceFor(r)}
          >
            开发票
          </Button>
          <Button size="small" onClick={() => setDetail(r)}>详情</Button>
        </Space>
      ),
    },
  ], [confirmingId, deletingId, cancelingId, setInvoiceFor, sortKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  const filterBar = !archived && (
    <Space wrap style={{ marginBottom: 12 }}>
      <Select style={{ width: 130 }} value={status} onChange={setStatus} placeholder="全部状态"
        options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} allowClear />
      <Select style={{ width: 180 }} value={customerId} onChange={setCustomerId} placeholder="全部客户"
        options={customers.map((c) => ({ value: c.id, label: optionLabel(c.name) }))} allowClear />
      <Input.Search placeholder="单号/PO号搜索" style={{ width: 200 }} allowClear
        onSearch={(v) => { setKw(v); fetchRows() }} />
      {/* I17：识单落草稿的单据可能缺价/缺交期/未建档 —— 一键筛出并逐项补全 */}
      <Space size={4}>
        <Switch size="small" checked={pendingOnly} onChange={setPendingOnly} />
        <Text style={{ fontSize: 12 }}>仅看有未补全项的草稿单</Text>
      </Space>
      {/* I17 裁定②（口径收窄「只看客户」）：默认只隐藏「客户是占位档案」的单据，此开关仅供排查 */}
      <Space size={4}>
        <Tooltip title={ORDER_PLACEHOLDER_HINT}>
          <Switch size="small" checked={showPlaceholders} onChange={setShowPlaceholders} />
        </Tooltip>
        <Tooltip title={ORDER_PLACEHOLDER_HINT}>
          <Text style={{ fontSize: 12, cursor: 'help' }}>显示占位客户档案</Text>
        </Tooltip>
      </Space>
      <Button onClick={fetchRows}>查询</Button>
    </Space>
  )

  return (
    <Card title={archived ? '归档（已完成订单 · 可反查）' : '订单列表'} size="small">
      {filterBar}
      {/* 组合排序状态条：与表头序号 1/2/3 同源，用户随时看清「先按什么排、再按什么排」 */}
      <Space wrap size={8} style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>排序：</Text>
        {sortKeys.map((k, i) => (
          <Tag key={k.field} color="blue" style={{ marginInlineEnd: 0 }}>
            {i + 1}. {ORDER_SORT_LABEL[k.field]} {k.dir === 'desc' ? '降序' : '升序'}
          </Tag>
        ))}
        <Button size="small" onClick={() => setSortKeys(DEFAULT_ORDER_SORT)} disabled={isDefaultOrderSort(sortKeys)}>
          重置排序
        </Button>
        {isDefaultOrderSort(sortKeys) && (
          <Text type="secondary" style={{ fontSize: 12 }}>默认排序（交期 降序；「待定交期」的草稿排最后）</Text>
        )}
      </Space>
      {archived && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '16px 0', color: '#999' }}>
          暂无已完成订单 —— 订单全部完成后自动进入归档
        </div>
      )}
      <Table<Order>
        rowKey="id" loading={loading} size="small" columns={columns} dataSource={rows}
        // 组合排序：受控排序键（sortOrder）+ 表头点击回调（onChange），实际排序由后端 sort 参数执行
        onChange={handleTableChange}
        // 列宽固定 + 横向滚动：窄屏不再把各列挤成换行；订单号/操作 两侧固定，滚动时仍可见
        scroll={{ x: 1780 }}
        expandable={{
          // 展开行 = 该单产品明细小表格（默认全部收起）
          expandedRowRender: (r) => <OrderLinesDetail order={r} />,
          rowExpandable: (r) => (r.lines?.length ?? 0) > 0,
          columnWidth: 36,
          expandIcon: ({ expanded, onExpand, record }) => (
            <Tooltip title={expanded ? '收起产品明细' : `展开产品明细（${record.lines?.length ?? 0} 行）`}>
              <Button
                type="text" size="small" style={{ padding: 0, width: 22, height: 22 }}
                aria-label={expanded ? '收起产品明细' : '展开产品明细'}
                onClick={(e) => onExpand(record, e)}
              >
                {expanded ? <DownOutlined style={{ fontSize: 11 }} /> : <RightOutlined style={{ fontSize: 11 }} />}
              </Button>
            </Tooltip>
          ),
        }}
        pagination={{ pageSize: 10, showSizeChanger: false }} />
      <OrderDetailModal order={detail} open={!!detail} onClose={() => setDetail(null)} />
      {/* I17 补全面板：列出待补项，支持「一键从报价记录取价」 */}
      <DraftFillModal order={fillFor} onClose={() => setFillFor(null)} onChanged={fetchRows} onEdit={onEdit} />
      {/* 快捷开票：关联订单已带入且锁定，开票金额默认 = 价格 − 已开票，点「确定开票」即结清 */}
      <InvoiceFormModal
        open={!!invoiceFor}
        edit={null}
        customers={customers}
        orders={rows}
        prefill={invoiceFor ? {
          orderIds: [invoiceFor.id],
          customerId: invoiceFor.customerId,
          amountInclCents: Math.max(0, invoiceFor.uninvoicedCents ?? 0),
          lockOrders: true,
        } : null}
        onClose={(reload) => { setInvoiceFor(null); if (reload) fetchRows() }}
      />
    </Card>
  )
}
