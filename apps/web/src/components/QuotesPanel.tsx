import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select,
  Space, Switch, Table, Tag, Tooltip, Typography, Upload, message,
} from 'antd'
import { DownloadOutlined, InboxOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { ColumnsType } from 'antd/es/table'
import type { UploadProps } from 'antd'
import { api, loadOptions } from '../lib/api'
import { fmtCents } from '../lib/money'
import { getToken } from '../lib/token'

/**
 * 报价记录（I17）—— 独立单据「报价单」的前端。
 * ------------------------------------------------------------------
 * 甲方核心诉求：**方便更新**（价格会变，要能快速改、留历史、按有效期生效）。因此：
 *   · 列表可就地改单价（点单价直接改，PUT /quotes/:id/price，服务端写 updated_at/operator 留痕）；
 *   · 同「客户+产品」的不同有效期是不同记录，不互相覆盖 → 历史价保留可查；
 *   · 批量导入走 preview（新增/改价/跳过/错误分类）→ 确认导入；
 *   · 「取价试算」小工具与识单补价共用服务端同一套取价规则（客户+产品 > 客户+产品名文本 > 通用价）。
 */

const { Text } = Typography

export interface QuoteRow {
  id: number
  customerId: number | null
  customerName: string | null
  productId: number | null
  productName: string | null
  unitPriceCents: number
  unitPrice: number
  currency: string
  validFrom: string | null
  validTo: string | null
  source: string
  sourceFile: string | null
  remark: string | null
  enabled: boolean
  operatorName: string | null
  updatedAt: string
  effective: boolean
}

interface QuoteList { total: number; page: number; pageSize: number; rows: QuoteRow[] }
interface RefRow { id: number; name: string }
interface LookupHit {
  quoteId: number; rule: string; ruleText: string; unitPriceCents: number; currency: string
  validFrom: string | null; validTo: string | null; source: string; remark: string | null
}
interface LookupResp { hit: LookupHit | null; evaluated: number; onDate: string; hint: string }

const SOURCE_LABEL: Record<string, string> = { manual: '手工录入', import: '批量导入', doc: '文档提取' }

const fmtDt = (v?: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—')
const fmtSpan = (r: QuoteRow) => (r.validFrom || r.validTo ? (r.validFrom ?? '不限') + ' ~ ' + (r.validTo ?? '不限') : '长期有效')

/** 单价单元格：点击就地改价（回车或失焦保存）——「价格会变，要能快速改」的落地 */
function PriceCell({ row, onSaved }: { row: QuoteRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState<number | null>(row.unitPrice)
  const busy = useRef(false)

  async function save() {
    if (busy.current) return
    if (val === null || val === undefined || Number(val) === row.unitPrice) { setEditing(false); return }
    busy.current = true
    try {
      await api('/quotes/' + row.id + '/price', { method: 'PUT', body: { unitPrice: Number(val) } })
      message.success('已改价 ' + fmtCents(row.unitPriceCents) + ' → ' + Number(val).toFixed(2) + '（已写留痕）')
      setEditing(false)
      onSaved()
    } catch (e) {
      message.error('改价失败：' + (e as Error).message)
    } finally {
      busy.current = false
    }
  }

  if (!editing) {
    return (
      <Tooltip title="点击就地改价（价格会变，改价留痕：updated_at + 操作人）">
        <span
          style={{ cursor: 'pointer', borderBottom: '1px dashed #91caff', paddingBottom: 1 }}
          onClick={() => { setVal(row.unitPrice); setEditing(true) }}
        >
          {fmtCents(row.unitPriceCents)}
        </span>
      </Tooltip>
    )
  }
  return (
    <InputNumber
      size="small"
      autoFocus
      min={0}
      step={0.1}
      precision={2}
      style={{ width: 104 }}
      value={val}
      onChange={(v) => setVal(v as number | null)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false) }}
    />
  )
}

/** 报价记录主面板：筛选 + 列表 + 新增/编辑 + 就地改价 + 停用启用 */
export default function QuotesPanel({ onChanged }: { onChanged?: () => void }) {
  const [customers, setCustomers] = useState<RefRow[]>([])
  const [products, setProducts] = useState<RefRow[]>([])
  const [rows, setRows] = useState<QuoteRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)

  const [fCustomer, setFCustomer] = useState<number | undefined>()
  const [fProduct, setFProduct] = useState<number | undefined>()
  const [fKw, setFKw] = useState('')
  const [fEffective, setFEffective] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<QuoteRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (fCustomer) qs.set('customerId', String(fCustomer))
      if (fProduct) qs.set('productId', String(fProduct))
      if (fKw.trim()) qs.set('kw', fKw.trim())
      if (fEffective) qs.set('effective', '1')
      qs.set('page', String(page))
      qs.set('pageSize', String(pageSize))
      const r = await api<QuoteList>('/quotes?' + qs.toString())
      setRows(r.rows)
      setTotal(r.total)
    } catch (e) {
      message.error('加载报价记录失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [fCustomer, fProduct, fKw, fEffective, page, pageSize])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    loadOptions<RefRow>('/customers', setCustomers, '客户')
    loadOptions<RefRow>('/products', setProducts, '产品')
  }, [])

  const bump = () => { void load(); onChanged?.() }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ currency: 'CNY', enabled: true })
    setModalOpen(true)
  }

  function openEdit(r: QuoteRow) {
    setEditing(r)
    form.setFieldsValue({
      customerId: r.customerId ?? undefined,
      productId: r.productId ?? undefined,
      productName: r.productName ?? undefined,
      unitPrice: r.unitPrice,
      currency: r.currency,
      validFrom: r.validFrom ? dayjs(r.validFrom) : undefined,
      validTo: r.validTo ? dayjs(r.validTo) : undefined,
      remark: r.remark ?? undefined,
      enabled: r.enabled,
    })
    setModalOpen(true)
  }

  async function submit() {
    const v = await form.validateFields()
    const body = {
      customerId: v.customerId ?? null,
      productId: v.productId ?? null,
      productName: v.productName ?? null,
      unitPrice: Number(v.unitPrice),
      currency: v.currency ?? 'CNY',
      validFrom: v.validFrom ? dayjs(v.validFrom).format('YYYY-MM-DD') : null,
      validTo: v.validTo ? dayjs(v.validTo).format('YYYY-MM-DD') : null,
      remark: v.remark ?? null,
      enabled: v.enabled !== false,
    }
    setSaving(true)
    try {
      if (editing) {
        await api('/quotes/' + editing.id, { method: 'PATCH', body })
        message.success('已保存（自动留痕）')
      } else {
        await api('/quotes', { method: 'POST', body })
        message.success('已新增报价')
      }
      setModalOpen(false)
      bump()
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function toggle(r: QuoteRow) {
    try {
      await api('/quotes/' + r.id + '/enabled', { method: 'PATCH', body: { enabled: !r.enabled } })
      message.success(r.enabled ? '已停用（历史行保留，不再参与取价）' : '已启用')
      bump()
    } catch (e) {
      message.error('操作失败：' + (e as Error).message)
    }
  }

  const columns: ColumnsType<QuoteRow> = useMemo(() => [
    { title: '客户', dataIndex: 'customerName', width: 150, render: (v: string | null) => (v ? v : <Tag color="orange">通用价（不限客户）</Tag>) },
    { title: '产品', dataIndex: 'productName', render: (v: string | null, r) => (v ? (r.productId ? v : v + ' ') : '—') },
    {
      title: '单价', dataIndex: 'unitPriceCents', width: 130, align: 'right',
      render: (_: unknown, r) => <PriceCell row={r} onSaved={bump} />,
    },
    { title: '币种', dataIndex: 'currency', width: 80 },
    { title: '有效期', key: 'span', width: 200, render: (_: unknown, r) => <Text style={{ fontSize: 12 }}>{fmtSpan(r)}</Text> },
    { title: '来源', dataIndex: 'source', width: 100, render: (v: string) => SOURCE_LABEL[v] ?? v },
    {
      title: '状态', dataIndex: 'effective', width: 110,
      render: (v: boolean, r) => (r.enabled
        ? (v ? <Tag color="success">生效中</Tag> : <Tag color="warning">未生效/已过期</Tag>)
        : <Tag>已停用</Tag>),
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{fmtDt(v)}</Text> },
    {
      title: '操作', width: 150, fixed: 'right',
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title={r.enabled ? '停用后不参与取价（历史保留），确认？' : '确认启用该报价？'} onConfirm={() => toggle(r)}>
            <Button size="small" danger={r.enabled}>{r.enabled ? '停用' : '启用'}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card
      title="报价记录"
      size="small"
      extra={
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          <Button type="primary" size="small" onClick={openCreate}>+ 新增报价</Button>
        </Space>
      }
    >
      <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
        价格会变 → 点单价可<b>就地改价</b>（写 updated_at + 操作人留痕）；同「客户+产品」的不同<b>有效期</b>是不同记录，按生效日自动取最新；
        客户留空 = 通用价；产品留空只填产品名也可（允许尚未建档的产品先报价）。
      </div>
      <Space wrap size={8} style={{ marginBottom: 10 }}>
        <Select
          allowClear showSearch optionFilterProp="label" placeholder="客户（含通用价）" style={{ width: 190 }}
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
          value={fCustomer} onChange={(v) => { setPage(1); setFCustomer(v) }}
        />
        <Select
          allowClear showSearch optionFilterProp="label" placeholder="产品" style={{ width: 190 }}
          options={products.map((c) => ({ value: c.id, label: c.name }))}
          value={fProduct} onChange={(v) => { setPage(1); setFProduct(v) }}
        />
        <Input
          allowClear placeholder="关键词（产品名/备注/来源文件）" style={{ width: 230 }}
          value={fKw} onChange={(e) => setFKw(e.target.value)}
          onPressEnter={() => { setPage(1); void load() }}
        />
        <Space size={4}>
          <Switch size="small" checked={fEffective} onChange={(v) => { setPage(1); setFEffective(v) }} />
          <Text style={{ fontSize: 12 }}>仅看当前有效</Text>
        </Space>
        <Button size="small" type="primary" ghost icon={<SearchOutlined />} onClick={() => { setPage(1); void load() }}>查询</Button>
      </Space>

      <Table<QuoteRow>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1180 }}
        pagination={{
          current: page, pageSize, total, showSizeChanger: true, size: 'small',
          showTotal: (t) => '共 ' + t + ' 条',
          onChange: (p, ps) => { setPage(p); setPageSize(ps) },
        }}
      />

      <Modal
        title={editing ? '编辑报价 #' + editing.id : '新增报价'}
        open={modalOpen}
        onOk={submit}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
        width={520}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="unitPrice" label="单价（元，主字段）" rules={[{ required: true, message: '单价必填' }]}>
            <InputNumber style={{ width: '100%' }} min={0} step={0.1} precision={2} autoFocus placeholder="如 13.20" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="customerId" label="客户（留空 = 通用价）" style={{ flex: 1, minWidth: 220 }}>
              <Select allowClear showSearch optionFilterProp="label" placeholder="不限客户"
                options={customers.map((c) => ({ value: c.id, label: c.name }))} />
            </Form.Item>
            <Form.Item name="currency" label="币种" style={{ width: 110 }}>
              <Select options={[{ value: 'CNY', label: 'CNY' }, { value: 'RMB', label: 'RMB' }, { value: 'USD', label: 'USD' }]} />
            </Form.Item>
          </Space>
          <Form.Item name="productId" label="产品（可留空）">
            <Select allowClear showSearch optionFilterProp="label" placeholder="从产品目录选（留空则只按产品名文本匹配）"
              options={products.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="productName" label="产品名文本（产品未建档时填这里）">
            <Input placeholder="如 1-101 割嘴 00#" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="validFrom" label="生效日期（可空）" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} placeholder="留空 = 不设起始" />
            </Form.Item>
            <Form.Item name="validTo" label="失效日期（可空）" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} placeholder="留空 = 不设到期" />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="如：2026 年铜价上调，报价按此执行" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

// ==================== 取价试算小工具（与识单补价同一套规则） ====================
export function QuoteLookupCard() {
  const [customers, setCustomers] = useState<RefRow[]>([])
  const [products, setProducts] = useState<RefRow[]>([])
  const [customerId, setCustomerId] = useState<number | undefined>()
  const [productId, setProductId] = useState<number | undefined>()
  const [productName, setProductName] = useState('')
  const [res, setRes] = useState<LookupResp | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadOptions<RefRow>('/customers', setCustomers, '客户')
    loadOptions<RefRow>('/products', setProducts, '产品')
  }, [])

  async function run() {
    setBusy(true)
    try {
      const qs = new URLSearchParams()
      if (customerId) qs.set('customerId', String(customerId))
      if (productId) qs.set('productId', String(productId))
      if (productName.trim()) qs.set('productName', productName.trim())
      setRes(await api<LookupResp>('/quotes/lookup?' + qs.toString()))
    } catch (e) {
      message.error('试算失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card size="small" title="按客户 + 产品试算取价" extra={<Text type="secondary" style={{ fontSize: 12 }}>与识单自动补价同一套规则</Text>}>
      <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
        优先级：<Tag color="green">客户+产品</Tag> → <Tag color="blue">客户+产品名文本</Tag> → <Tag color="orange">通用价（不限客户）</Tag>；
        同一档内取「生效日最新且在有效期内」的一条。
      </div>
      <Space wrap size={8}>
        <Select allowClear showSearch optionFilterProp="label" placeholder="客户" style={{ width: 190 }}
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
          value={customerId} onChange={setCustomerId} />
        <Select allowClear showSearch optionFilterProp="label" placeholder="产品（可选）" style={{ width: 190 }}
          options={products.map((c) => ({ value: c.id, label: c.name }))}
          value={productId} onChange={setProductId} />
        <Input placeholder="或直接填产品名文本" style={{ width: 200 }} value={productName} onChange={(e) => setProductName(e.target.value)} />
        <Button type="primary" size="small" loading={busy} onClick={run}>试算</Button>
      </Space>
      {res && (
        <Alert
          style={{ marginTop: 10 }}
          type={res.hit ? 'success' : 'warning'}
          showIcon
          message={res.hit
            ? '取到单价 ' + fmtCents(res.hit.unitPriceCents) + ' ' + res.hit.currency + '（命中规则：' + res.hit.ruleText + '）'
            : '未命中有效报价'}
          description={
            <div style={{ fontSize: 12 }}>
              <div>{res.hint}</div>
              <div>基准日 {res.onDate}，参与判定的候选报价 {res.evaluated} 条</div>
              {res.hit && (
                <div>
                  报价单号 #{res.hit.quoteId}　有效期 {res.hit.validFrom ?? '不限'} ~ {res.hit.validTo ?? '不限'}
                  　来源 {SOURCE_LABEL[res.hit.source] ?? res.hit.source}
                  {res.hit.remark ? '　备注：' + res.hit.remark : ''}
                </div>
              )}
            </div>
          }
        />
      )}
    </Card>
  )
}

// ==================== 批量导入（preview 分类统计 → commit） ====================
type QuoteRowStatus = 'new' | 'update' | 'skip' | 'error'
interface PreviewRow { rowNo: number; status: QuoteRowStatus; reasons: string[]; data: Record<string, string | number | null>; raw: string[] }
interface QuoteSummary { total: number; new: number; update: number; skip: number; error: number }
interface PreviewResult { fileKind: string; headerRowIndex: number; columns: Record<string, number>; unmappedHeaders: string[]; summary: QuoteSummary; rows: PreviewRow[] }
interface CommitResult { summary: QuoteSummary; created: Array<{ rowNo: number; id: number; label: string }>; updated: Array<{ rowNo: number; id: number; label: string }>; failures: Array<{ rowNo: number; label: string; reason: string }> }

const STATUS_META: Record<QuoteRowStatus, { text: string; color: string }> = {
  new: { text: '新增', color: 'green' },
  update: { text: '改价', color: 'blue' },
  skip: { text: '跳过', color: 'default' },
  error: { text: '错误', color: 'red' },
}

const MAX_FILE = 8 * 1024 * 1024

export function QuoteImportCard({ onDone }: { onDone?: () => void }) {
  const [mode, setMode] = useState<'insert-only' | 'upsert'>('insert-only')
  const [fileName, setFileName] = useState('')
  const [dataUrl, setDataUrl] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [result, setResult] = useState<CommitResult | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)

  async function doPreview(file: string, name: string, m = mode) {
    setBusy('preview')
    setResult(null)
    try {
      const r = await api<PreviewResult>('/quotes/import/preview', { method: 'POST', body: { mode: m, file, fileName: name } })
      setPreview(r)
      if (!r.summary.new && !r.summary.update) message.info('没有需要导入的行（' + r.summary.total + ' 行全部为跳过/错误）')
    } catch (e) {
      setPreview(null)
      message.error('解析预览失败：' + (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function doCommit() {
    if (!dataUrl) return
    setBusy('commit')
    try {
      const r = await api<CommitResult>('/quotes/import/commit', { method: 'POST', body: { mode, file: dataUrl, fileName } })
      setResult(r)
      const s = r.summary
      if (s.error) message.warning('导入完成：新增 ' + s.new + '，改价 ' + s.update + '，跳过 ' + s.skip + '，失败 ' + s.error + '（详见失败清单）')
      else message.success('导入完成：新增 ' + s.new + '，改价 ' + s.update + '，跳过 ' + s.skip)
      onDone?.()
    } catch (e) {
      message.error('导入失败（未写入任何数据）：' + (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function downloadTemplate() {
    try {
      const res = await fetch('/api/quotes/template', { headers: { Authorization: 'Bearer ' + (getToken() ?? '') } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') ?? ''
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
      const name = m ? decodeURIComponent(m[1]) : '报价记录导入模板.csv'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      message.error('模板下载失败：' + (e as Error).message)
    }
  }

  const uploadProps: UploadProps = {
    accept: '.xls,.xlsx,.csv,.tsv',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      const f = file as unknown as File
      if (!/\.(xls|xlsx|csv|tsv)$/.test(f.name.toLowerCase())) { message.error('仅支持 .xls / .xlsx / .csv 表格文件'); return false }
      if (f.size > MAX_FILE) { message.error('文件超过 8MB，请精简后重试'); return false }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        setFileName(f.name)
        setDataUrl(url)
        void doPreview(url, f.name)
      }
      reader.onerror = () => message.error('文件读取失败，请重新选择')
      reader.readAsDataURL(f)
      return false
    },
  }

  const cols: ColumnsType<PreviewRow> = [
    { title: '行号', dataIndex: 'rowNo', width: 70, align: 'right' },
    { title: '结论', dataIndex: 'status', width: 80, render: (s: QuoteRowStatus) => <Tag color={STATUS_META[s].color}>{STATUS_META[s].text}</Tag> },
    { title: '客户', width: 150, render: (_: unknown, r) => String(r.data.customerName ?? '（通用价）') },
    { title: '产品', width: 200, ellipsis: true, render: (_: unknown, r) => String(r.data.productName ?? '—') },
    { title: '单价', width: 90, align: 'right', render: (_: unknown, r) => (r.data.unitPrice === null || r.data.unitPrice === undefined ? '—' : String(r.data.unitPrice)) },
    { title: '币种', width: 70, render: (_: unknown, r) => String(r.data.currency ?? 'CNY') },
    { title: '生效', width: 105, render: (_: unknown, r) => String(r.data.validFrom ?? '—') },
    { title: '失效', width: 105, render: (_: unknown, r) => String(r.data.validTo ?? '—') },
    { title: '原因 / 说明', dataIndex: 'reasons', ellipsis: true, render: (rs: string[]) => (rs?.length ? <Text type="secondary" style={{ fontSize: 12 }}>{rs.join('；')}</Text> : '—') },
  ]

  const s = preview?.summary
  return (
    <Card
      size="small"
      title="报价记录 · 批量导入（Excel / CSV）"
      extra={<Button size="small" icon={<DownloadOutlined />} onClick={downloadTemplate}>下载导入模板</Button>}
    >
      <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
        表头：客户名称（可空 = 通用价）/ 产品名称 / 单价（必填）/ 币种 / 生效日期 / 失效日期 / 备注。
        上传只做预览校验，点「确认导入」才写库；「新增或改价」模式下同「客户+产品+生效日」的记录会被改价而不是重复新增。
      </div>
      <Space wrap size={12} style={{ marginBottom: 8 }}>
        <Radio.Group size="small" value={mode} onChange={(e) => { const m = e.target.value; setMode(m); setResult(null); if (dataUrl) void doPreview(dataUrl, fileName, m) }}>
          <Radio.Button value="insert-only">仅新增（已存在则跳过）</Radio.Button>
          <Radio.Button value="upsert">新增或改价（同键改价）</Radio.Button>
        </Radio.Group>
        {dataUrl && <Button size="small" loading={busy === 'preview'} onClick={() => void doPreview(dataUrl, fileName)}>重新预览</Button>}
      </Space>
      <Upload.Dragger {...uploadProps} disabled={!!busy}>
        <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}><InboxOutlined /></p>
        <p className="ant-upload-text" style={{ fontSize: 14 }}>点击选择或把报价表格拖到这里</p>
        <p className="ant-upload-hint" style={{ fontSize: 12 }}>支持 .xls（Excel 97-2003）/ .xlsx / .csv；单文件 ≤ 8MB</p>
      </Upload.Dragger>

      {preview && s && (
        <div style={{ marginTop: 12 }}>
          <Space wrap size={8} style={{ marginBottom: 8 }}>
            <Text strong>预览（{fileName}，{preview.fileKind}）</Text>
            <Tag color="green">新增 {s.new}</Tag>
            <Tag color="blue">改价 {s.update}</Tag>
            <Tag>跳过 {s.skip}</Tag>
            <Tag color={s.error ? 'red' : 'default'}>错误 {s.error}</Tag>
            <Button type="primary" size="small" loading={busy === 'commit'} disabled={!s.new && !s.update} onClick={doCommit}>
              确认导入（{s.new + s.update} 行）
            </Button>
          </Space>
          {preview.unmappedHeaders.length > 0 && (
            <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={'未识别的列（不会导入）：' + preview.unmappedHeaders.join('、')} />
          )}
          <Table<PreviewRow> size="small" rowKey="rowNo" columns={cols} dataSource={preview.rows}
            pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }} scroll={{ x: 1100 }} />
        </div>
      )}

      {result && (
        <Alert
          style={{ marginTop: 12 }}
          type={result.summary.error ? 'warning' : 'success'}
          showIcon
          message={'导入结果：新增 ' + result.summary.new + '，改价 ' + result.summary.update + '，跳过 ' + result.summary.skip + '，失败 ' + result.summary.error}
          description={result.failures.length > 0 ? (
            <div style={{ fontSize: 12 }}>
              <div style={{ marginBottom: 4 }}>失败清单（未写入，可修正后重新导入）：</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {result.failures.map((f) => <li key={f.rowNo + '-' + f.label}>第 {f.rowNo} 行（{f.label}）：{f.reason}</li>)}
              </ul>
            </div>
          ) : '全部行处理完成'}
        />
      )}
    </Card>
  )
}
