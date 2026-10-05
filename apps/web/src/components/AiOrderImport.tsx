import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, DatePicker, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload, message,
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api, loadOptions } from '../lib/api'
import type { Customer, Order, PackagingSpec, Product } from '../lib/types'
import PackComboEditor from './PackComboEditor'

const { Text } = Typography
const MAX_FILE = 8 * 1024 * 1024 // 8MB（nginx/后端 12mb 内）
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i

// ===== 后端 /api/ai/orders/parse 的返回结构（与 order-parser.service 对齐）=====
export interface AiIssue { path: string; level: 'error' | 'warn'; message: string }
export interface AiParsedLine {
  productName: string; productId: number | null; match: 'exact' | 'none'
  quantity?: number; unitPrice?: number; currency?: 'RMB' | 'USD'
  engraving?: string; packaging?: PackagingSpec; issues: AiIssue[]
  /** 行金额（分）——后端按 common/money 定点计算，前端只做展示 */
  amountCents?: number
}
export interface AiResolveResult {
  customerId: number | null; customerName: string; customerMatch: 'exact' | 'none'
  poNo?: string; dueDate?: string; note?: string
  lines: AiParsedLine[]; issues: AiIssue[]
  confidence: 'high' | 'low'; notes: string[]
  directPass: boolean
  /** 订单合计金额（分） */
  totalCents?: number
  /** 解析通道：text / image / table-rule（Excel/CSV 规则映射）/ table-llm（表格 LLM 兜底）/ stub */
  parseSource?: 'text' | 'image' | 'table-rule' | 'table-llm' | 'stub'
  /** 表格映射诊断（仅 Excel/CSV）：命中率、缺失列、是否走了 LLM、数据行边界、抬头区 */
  table?: {
    headerRowIndex: number; hitRate: number; requiredHits: number
    /** 本次口径的关键列总数（给了 folderCustomer → 3：客户列不再必填） */
    requiredTotal?: number
    missingRequired: string[]; dataRowCount: number; usedLlm: boolean
    /** 数据行终止原因（合计/大写金额/正唛/备注/合同条款/表尾） */
    stopReason?: string
    /** 被跳过的非产品行数（条款/大写金额/正唛/空行） */
    skippedNoiseRows?: number
    /** 抬头区 + 条款区扫描结果（合同编号/供方/需方/交货期限） */
    headerArea?: { poNo?: string; dueDate?: string; customerName?: string; supplierName?: string; matches: string[] }
    /** 客户由所属文件夹决定 */
    folderCustomer?: string
    /** 口径校验提示（如抬头需方与文件夹客户不一致） */
    warnings?: string[]
  }
}

/** AI 复核确认后回传给新建订单表单的载荷（未命中档案的客户/产品以文本原样带入） */
export interface AiFillLine {
  productId?: number
  productName?: string // AI 识别原文（未建档时新建订单页用文本提示建档）
  quantity?: number; unitPrice?: number; currency: 'RMB' | 'USD'
  engraving?: string; packaging?: PackagingSpec
}
export interface AiFillPayload {
  customerId?: number // 命中档案时
  customerText?: string // 未建档客户名（新建订单页快速建档用）
  poNo?: string; dueDate?: string; note?: string
  lines: AiFillLine[]
  /** 解析原始结果（供订单页建单成功后上报学习反馈） */
  result: AiResolveResult
}

interface Props {
  /** 复核确认：把草稿（含未建档文本）交回订单页，由用户最终检测/建档/保存 */
  onReviewDone?: (payload: AiFillPayload) => void
  /** 已直接生成草稿订单（Excel 全字段命中时）：通知订单页刷新列表并切到列表页 */
  onDraftCreated?: () => void
}

/** 可编辑草稿行 */
interface EditLine {
  productId?: number; productName?: string
  quantity?: number; unitPrice?: number; currency: 'RMB' | 'USD'
  engraving?: string; packaging?: PackagingSpec
  _unmatched: boolean // AI 未匹配到目录产品 → 允许按识别名带过去，新建订单页建档
  _browse?: boolean // 从目录浏览（切出文本编辑态）
}
interface EditDraft {
  customerId?: number; customerText?: string
  poNo?: string; dueDate?: string; note?: string
  lines: EditLine[]
}

/** Excel/CSV 表格预览行（客户/产品/数量/单价/金额/交期；金额以「分」派生自可编辑草稿） */
interface PreviewRow {
  key: number
  customer: string
  product: string
  quantity?: number
  unitPrice?: number
  amountCents: number
  dueDate: string
}

const PREVIEW_COLUMNS: ColumnsType<PreviewRow> = [
  { title: '客户', dataIndex: 'customer', width: 170, render: (v: string) => v || '—' },
  { title: '产品', dataIndex: 'product', width: 240, render: (v: string) => v || '—' },
  { title: '数量', dataIndex: 'quantity', width: 90, align: 'right', render: (v?: number) => (v === undefined ? '—' : v) },
  { title: '单价（元）', dataIndex: 'unitPrice', width: 100, align: 'right', render: (v?: number) => (v === undefined ? '—' : v.toFixed(2)) },
  { title: '金额（元）', dataIndex: 'amountCents', width: 110, align: 'right', render: (v: number) => (v ? (v / 100).toFixed(2) : '0.00') },
  { title: '交期', dataIndex: 'dueDate', width: 120, render: (v: string) => v || '—' },
]

const todayStr = () => dayjs().format('YYYY-MM-DD')
const fmtTime = (iso: string) => dayjs(iso).format('MM-DD HH:mm')

/** 后端单槽草稿（I14：GET/POST/DELETE /ai/orders/draft） */
interface SavedDraft {
  result: AiResolveResult
  draft: EditDraft
  updatedAt: string
}

/** 金额（分 → 元，两位小数）：与后端 common/money 的 lineCents 同口径（定点，避免浮点尾差） */
const centsOf = (quantity?: number, unitPrice?: number) =>
  Math.round(quantity || 0) * Math.round((unitPrice || 0) * 100)
const yuan = (cents: number) => (cents / 100).toFixed(2)

/** AI 订单导入：图片/文本/Excel(CSV) → 解析预览（低置信标红）→ 人工修正
 *  → 全字段命中可「生成草稿订单」（恒为草稿态）；未建档项则填入新建订单表单由订单页承接 */
export default function AiOrderImport({ onReviewDone, onDraftCreated }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AiResolveResult | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [textOpen, setTextOpen] = useState(false)
  const [textVal, setTextVal] = useState('')
  const [saving, setSaving] = useState(false)
  // ---- I14 草稿单槽持久化：saved=后端已有未提交草稿；draft/result 打开编辑时由防抖自动保存 ----
  const [saved, setSaved] = useState<SavedDraft | null>(null)
  const saveTimer = useRef<number>(0)
  const failNotified = useRef(false)

  async function saveDraft(result: AiResolveResult, draft: EditDraft) {
    try {
      await api('/ai/orders/draft', { method: 'POST', body: { result, draft } })
      failNotified.current = false
    } catch {
      if (!failNotified.current) {
        failNotified.current = true
        message.warning('草稿自动保存失败，请暂勿刷新/关闭页面')
      }
    }
  }

  /** 进入组件：拉取上次未提交草稿（有则顶部横幅提示可恢复） */
  useEffect(() => {
    api<{ draft: SavedDraft | null }>('/ai/orders/draft')
      .then((d) => { if (d?.draft) setSaved(d.draft) })
      .catch(() => {})
  }, [])

  /** 编辑中（result&&draft 同时存在）→ 防抖自动保存，任何一步修正都不丢 */
  useEffect(() => {
    if (!result || !draft) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { saveDraft(result, draft) }, 700)
    return () => window.clearTimeout(saveTimer.current)
  }, [result, draft])

  /** 关闭复核弹窗：先落最终稿 → 存为可恢复草稿 → 清空内存（不吞人工修正） */
  function cancelReview() {
    if (result && draft) {
      setSaved({ result, draft, updatedAt: new Date().toISOString() })
      saveDraft(result, draft)
    }
    setResult(null); setDraft(null)
  }

  /** 恢复上次草稿：载入 → 弹复核窗继续编辑 */
  function restoreSaved() {
    if (!saved) return
    setResult(saved.result)
    setDraft(saved.draft)
    setSaved(null)
  }

  /** 放弃草稿：删除后端记录并隐藏横幅 */
  function discardSaved() {
    api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
    setSaved(null)
  }

  useEffect(() => {
    loadOptions<Customer>('/customers', setCustomers, '客户档案')
    loadOptions<Product>('/products', setProducts, '产品目录')
  }, [])

  const productOptions = useMemo(
    () => products.map((p) => ({ value: p.id, label: `${p.name}（${p.type}）` })),
    [products],
  )

  /** 解析成功 → 生成可编辑草稿（未命中档案的客户/产品按识别文本保留，不做限制） */
  function openResult(r: AiResolveResult) {
    setResult(r)
    setDraft({
      customerId: r.customerId ?? undefined,
      customerText: r.customerMatch === 'none' && r.customerName ? r.customerName : undefined,
      poNo: r.poNo,
      dueDate: r.dueDate ?? todayStr(),
      note: r.note,
      lines: r.lines.map((l) => ({
        productId: l.productId ?? undefined,
        productName: l.productName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        currency: l.currency ?? 'RMB',
        engraving: l.engraving,
        packaging: l.packaging,
        _unmatched: l.productId === null,
      })),
    })
  }

  async function doParse(body: { text?: string; image?: string; file?: string; fileName?: string }, from: string) {
    // I14：已有未提交草稿时，新解析覆盖前需二次确认（不误吞修正内容）
    if (saved) {
      const go = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '已有未提交的 AI 订单草稿',
          content: `上次草稿保存于 ${fmtTime(saved.updatedAt)}。重新解析将覆盖它，继续？`,
          okText: '覆盖并重新解析',
          okType: 'danger',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      if (!go) return
      await api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
      setSaved(null)
    }
    setBusy(true)
    try {
      const r = await api<AiResolveResult>('/ai/orders/parse', { method: 'POST', body })
      if (!r.lines?.length) message.warning('AI 未能识别出产品行，请换更清晰的图/文本或手工录入')
      openResult(r)
      setTextOpen(false)
    } catch (e) {
      message.error(`${from}解析失败：${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  /**
   * 上传入口（拖拽/点选共用）：图片 / Excel(.xls、.xlsx) / CSV 三种走向。
   * - 图片 → dataURL 走既有 vision 识别（不受本次改动影响）
   * - xls/xlsx/csv → dataURL 走表格解析管线（规则映射优先，命中不足再走 LLM）
   * - .pdf → 前端即时中文提示（后端同样拦截，双保险）
   * 文件转 dataURL 直送（不经 multipart，与既有图片路径同一约定）
   */
  function pickFile(file: File) {
    const name = file.name.toLowerCase()
    if (name.endsWith('.pdf')) {
      message.error('PDF 暂不支持直接解析：请把订单页截图成图片上传，或另存为 .xls / .xlsx / .csv 后重试')
      return
    }
    const isImage = file.type.startsWith('image/') || IMG_EXT_RE.test(name)
    if (!isImage && !/\.(xls|xlsx|csv|tsv)$/.test(name)) {
      message.error('仅支持 Excel(.xls/.xlsx) / CSV 表格或订单图片，请重新选择文件')
      return
    }
    if (file.size > MAX_FILE) { message.error('文件超过 8MB，请精简后重试（大表可另存为 .csv）'); return }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      if (isImage) doParse({ image: dataUrl, fileName: file.name }, '图片')
      else doParse({ file: dataUrl, fileName: file.name }, '表格')
    }
    reader.onerror = () => message.error('文件读取失败，请重新选择')
    reader.readAsDataURL(file)
  }

  const uploadProps: UploadProps = {
    accept: 'image/*,.xls,.xlsx,.csv,.tsv',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      pickFile(file as unknown as File)
      return false // 阻止自动上传：统一由前端转 dataURL 直送
    },
  }

  function setRow(i: number, patch: Partial<EditLine>) {
    setDraft((d) => d ? { ...d, lines: d.lines.map((l, idx) => idx === i ? { ...l, ...patch } : l) } : d)
  }

  /** 复核确认：不在此建单，把草稿（含未建档客户/产品文本）填入下方「新建订单」表单，由订单页检测/建档/保存 */
  function confirmFill() {
    if (!draft || !onReviewDone) return
    if (!draft.lines.length) { message.warning('没有可填入的产品行'); return }
    setSaving(true)
    try {
      onReviewDone({
        customerId: draft.customerId,
        customerText: draft.customerText,
        poNo: draft.poNo,
        dueDate: draft.dueDate,
        note: draft.note,
        lines: draft.lines.map((l) => ({
          productId: l.productId,
          productName: l._unmatched ? (l.productName || undefined) : undefined,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          currency: l.currency,
          engraving: l.engraving,
          packaging: l.packaging,
        })),
        result: result as AiResolveResult,
      })
      // 草稿已被表单承接：清除内存与 DB 单槽（防下次进来横幅误导）
      setSaved(null)
      api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
      setResult(null); setDraft(null)
    } finally { setSaving(false) }
  }

  // ===== Excel/CSV：表格预览（客户/产品/数量/单价/金额/交期）+ 直接生成草稿订单 =====
  const isTable = !!result?.parseSource?.startsWith('table')

  /** 预览行：直接由可编辑草稿派生 —— 上方一改，预览同步更新（改完即所见） */
  const previewCustomer = draft?.customerId
    ? (customers.find((c) => c.id === draft.customerId)?.name ?? draft.customerText ?? '')
    : (draft?.customerText ?? '')
  const previewRows = (draft?.lines ?? []).map((l, i) => ({
    key: i,
    // 客户/交期是单头字段：每行都展示，便于按行核对（与单据表的阅读习惯一致）
    customer: previewCustomer,
    product: l.productId ? (products.find((p) => p.id === l.productId)?.name ?? l.productName ?? '') : (l.productName ?? ''),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amountCents: centsOf(l.quantity, l.unitPrice),
    dueDate: draft?.dueDate ?? '',
  }))
  const previewTotalCents = previewRows.reduce((s, r) => s + r.amountCents, 0)

  /** 可直接生成草稿订单的条件：客户命中档案 + 每行都有目录产品/数量/单价 */
  const draftReady = !!draft?.customerId
    && draft.lines.length > 0
    && draft.lines.every((l) => !!l.productId && !!l.quantity && l.quantity > 0 && l.unitPrice !== undefined && l.unitPrice !== null)

  /**
   * 生成草稿订单：复用既有 POST /orders（后端创建态恒为 draft，不是「已确认」）。
   * 只有全字段命中（客户/产品都在档案）才允许，避免把未建档数据写进 FK；
   * 有未建档项时引导用户走「按识别结果填入新建订单」→ 建档后保存。
   */
  async function createDraftOrder() {
    if (!draft || !result) return
    if (!draft.customerId) { message.warning('客户未匹配到档案：请先在上方选择客户（或走「填入新建订单」快速建档）'); return }
    const badIdx = draft.lines.findIndex((l) => !l.productId || !l.quantity || l.quantity <= 0 || l.unitPrice === undefined || l.unitPrice === null)
    if (badIdx >= 0) {
      message.warning('第 ' + (badIdx + 1) + ' 行产品/数量/单价未就绪：请在上方修正或改用「填入新建订单」建档后保存')
      return
    }
    const body = {
      customerId: draft.customerId,
      poNo: draft.poNo || undefined,
      dueDate: draft.dueDate,
      note: draft.note || undefined,
      lines: draft.lines.map((l) => ({
        productId: l.productId as number,
        quantity: l.quantity as number,
        unitPrice: l.unitPrice as number,
        currency: l.currency,
        engraving: l.engraving || undefined,
        packaging: (l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined),
      })),
    }
    setSaving(true)
    try {
      const created = await api<Order>('/orders', { method: 'POST', body })
      // 学习闭环：把「识别结果 + 人工最终稿」回流（Excel 来源单独标记，便于统计直通率）
      api('/ai/feedback', {
        method: 'POST',
        body: {
          source: isTable ? 'excel_import' : 'ai_import',
          parsed: result,
          corrected: body,
          directPass: result.directPass,
        },
      }).catch(() => {})
      api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
      message.success('已生成草稿订单 ' + created.orderNo + '（草稿态：需到订单列表「确认」后才生成计划单）')
      setSaved(null); setResult(null); setDraft(null)
      onDraftCreated?.()
    } catch (err) {
      message.error('生成草稿订单失败：' + (err as Error).message)
    } finally { setSaving(false) }
  }

  /**
   * 落草稿（I17）：识单结果 → **草稿订单 + 逐项待补标记**。
   * 与「生成草稿订单」的区别：不再要求客户/产品/数量/单价全部就绪 ——
   * 缺的项由服务端写成中文待补（缺价/缺交期/缺数量/产品未建档/客户未建档），
   * 之后到订单列表按「仅看有未补全项的草稿单」筛选并逐项补全（补价可一键取报价记录）。
   * 待补未清空前订单不能确认（服务端拦截），因此对下游没有脏数据风险。
   */
  async function createPendingDraft() {
    if (!draft || !result) return
    setSaving(true)
    try {
      // 客户优先用选中档案（customerId），否则用识别/文件夹客户名（未建档时服务端挂占位档案并标待补）
      const folder = (result.table?.folderCustomer as string | undefined) || undefined
      const created = await api<Order>('/orders/draft', {
        method: 'POST',
        body: {
          customerId: draft.customerId ?? null,
          customerName: draft.customerId ? null : (draft.customerText || null),
          folderCustomer: folder ?? null,
          poNo: draft.poNo || null,
          dueDate: draft.dueDate || null,
          note: draft.note || null,
          lines: draft.lines.map((l) => ({
            productId: l.productId ?? null,
            productName: l.productId ? null : (l.productName || null),
            quantity: l.quantity ?? null,
            unitPrice: l.unitPrice ?? null,
            currency: l.currency,
            engraving: l.engraving || undefined,
            packaging: (l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined),
          })),
        },
      })
      const pending = Array.isArray(created.pendingItems) ? created.pendingItems.length : 0
      message.success('已落草稿订单 ' + created.orderNo
        + (pending ? '（' + pending + ' 项待补：到订单列表按「仅看有未补全项的草稿单」筛选后补全）' : '（无待补项，可直接确认）'))
      api('/ai/feedback', {
        method: 'POST',
        body: { source: isTable ? 'excel_import_draft' : 'ai_import_draft', parsed: result, corrected: null, directPass: false },
      }).catch(() => {})
      api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
      setSaved(null); setResult(null); setDraft(null)
      onDraftCreated?.()
    } catch (err) {
      message.error('落草稿失败：' + (err as Error).message)
    } finally { setSaving(false) }
  }

  const unmatchedCount = draft?.lines.filter((l) => l._unmatched).length ?? 0
  const customerUnmatched = !!draft?.customerText && !draft.customerId

  return (
    <>
      <div style={{ border: '1px dashed #91caff', borderRadius: 8, padding: 10, marginBottom: 16, background: '#f0f7ff' }}>
        <Space wrap size={10} style={{ marginBottom: 8 }}>
          <Text strong style={{ color: '#0958d9' }}>📄 AI 导入订单</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            支持 Excel(.xls/.xlsx) / CSV（UTF-8、GBK 自动识别）与订单图片；识别后可在表格预览里逐项修正
          </Text>
          <Button size="small" loading={busy} onClick={() => setTextOpen(true)}>粘贴订单文本</Button>
        </Space>
        <Upload.Dragger {...uploadProps} disabled={busy}>
          <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}><InboxOutlined /></p>
          <p className="ant-upload-text" style={{ fontSize: 14 }}>点击选择或把 Excel / CSV / 订单图片拖到这里识别</p>
          <p className="ant-upload-hint" style={{ fontSize: 12 }}>
            .xls（Excel 97-2003）、.xlsx、.csv（含中文 GBK 编码）、.png/.jpg 等；格式按文件内容自动判定，扩展名写错也能识别；单文件 ≤ 8MB。
            识别结果恒为草稿，需人工核对后「生成草稿订单」或填入新建订单表单。
          </p>
        </Upload.Dragger>
      </div>

      {/* I14：上次未提交草稿（刷新/误关自动保存，可恢复继续编辑） */}
      {saved && !draft && (
        <div style={{ border: '1px solid #ffd591', borderRadius: 8, padding: '6px 10px', marginBottom: 12, background: '#fff7e6', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text style={{ color: '#d46b08', fontSize: 13 }}>💾 有未提交的 AI 订单草稿（上次编辑于 {fmtTime(saved.updatedAt)}，已自动保存）</Text>
          <Space size={6}>
            <Button size="small" type="primary" onClick={restoreSaved}>恢复草稿</Button>
            <Button size="small" danger onClick={discardSaved}>放弃</Button>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>中途刷新/误关弹窗都不丢；填入新建订单后自动清除</Text>
        </div>
      )}

      {/* 文本导入 */}
      <Modal title="粘贴订单文本（邮件正文/Excel 转文本）" open={textOpen} onCancel={() => setTextOpen(false)}
        onOk={() => { if (textVal.trim()) doParse({ text: textVal.trim() }, '文本') }}
        okText="开始识别" okButtonProps={{ disabled: !textVal.trim() || busy }} width={620}>
        <Input.TextArea rows={10} value={textVal} onChange={(e) => setTextVal(e.target.value)}
          placeholder={'示例：\nCustomer: Acme Welding Co.\nPO: PO-2026-0901\nDue: 2026-10-15\n1) ANM 3  2000 pcs  USD 4.20  engrave LOGO  pack: 100/box\n2) 6290  500 pcs  USD 3.80'} />
      </Modal>

      {/* 结果预览 + 人工复核（确认 = 填入下方新建订单表单） */}
      <Modal
        title={<>
          AI 识别结果 · 订单草稿
          {isTable && (
            <Tag color="geekblue" style={{ marginLeft: 6 }}>
              {result?.parseSource === 'table-rule' ? 'Excel/CSV 表头规则映射' : 'Excel/CSV AI 语义映射'}
            </Tag>
          )}
          <Tag color={result?.directPass ? 'green' : result?.confidence === 'low' ? 'orange' : 'blue'}>
            {result?.directPass ? '可直接确认' : result?.confidence === 'low' ? '低置信·需复核' : '需复核'}
          </Tag>
        </>}
        open={!!result && !!draft}
        onCancel={cancelReview}
        width={1080}
        footer={
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {customerUnmatched || unmatchedCount > 0
                ? `${customerUnmatched ? '客户 1 个、' : ''}${unmatchedCount} 个产品不在档案 —— 可点右侧「填入新建订单」一键快速建档`
                : result?.directPass ? 'AI 全字段通过规则校验，可直接生成草稿订单' : '按识别结果填入，可在新建订单页继续修正'}
            </Text>
            <Button onClick={cancelReview}>取消</Button>
            <Button loading={saving} onClick={confirmFill}>按识别结果填入新建订单</Button>
            <Button loading={saving} disabled={!draft?.lines.length} onClick={createPendingDraft}>
              存为草稿（缺项标待补）
            </Button>
            <Button type="primary" loading={saving} disabled={!draftReady} onClick={createDraftOrder}>
              生成草稿订单
            </Button>
          </Space>
        }
      >
        {result && draft && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {result.notes.length > 0 && (
              <Alert type="warning" showIcon message={result.notes.join('；')} style={{ fontSize: 12 }} />
            )}
            {result.issues.length > 0 && (
              <div style={{ maxHeight: 110, overflow: 'auto', background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}>
                {result.issues.map((it, idx) => (
                  <div key={idx} style={{ color: it.level === 'error' ? '#cf1322' : '#d46b08' }}>
                    {it.level === 'error' ? '🔴' : '🟡'} <Text code style={{ fontSize: 11 }}>{it.path}</Text> {it.message}
                  </div>
                ))}
              </div>
            )}

            {/* Excel/CSV 表格预览（客户/产品/数量/单价/金额/交期）—— 直接派生自下方可编辑草稿，改完即同步 */}
            {isTable && (
              <div style={{ border: '1px solid #e6f4ff', background: '#fafcff', borderRadius: 6, padding: '6px 8px' }}>
                <Space size={8} wrap style={{ marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 13 }}>📋 表格预览（识别结果）</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    表头关键列命中 {result?.table?.requiredHits ?? 0}/{result?.table?.requiredTotal ?? 4}
                    {result?.table?.folderCustomer ? '（客户取文件夹「' + result.table.folderCustomer + '」，不再要求表内客户列）' : ''}
                    {result?.table?.usedLlm ? '；已用 AI 语义映射兜底' : '；规则映射直接得出（未调用 AI）'}
                    {result?.table?.missingRequired?.length ? '；缺失列：' + result.table.missingRequired.join('、') : ''}
                    {result?.table?.stopReason ? '；数据行终止：' + result.table.stopReason : ''}
                    {result?.table?.skippedNoiseRows ? '；已跳过非产品行 ' + result.table.skippedNoiseRows + ' 行' : ''}
                    {result?.table?.headerArea?.poNo ? '；合同号：' + result.table.headerArea.poNo : ''}
                    {'；共 ' + previewRows.length + ' 行明细，合计 ' + yuan(previewTotalCents) + ' 元'}
                  </Text>
                </Space>
                <Table<PreviewRow>
                  size="small" pagination={false} dataSource={previewRows} columns={PREVIEW_COLUMNS}
                  locale={{ emptyText: '未识别到明细行' }}
                />
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  预览随下方修正实时更新；单价单位为「元」，金额按 数量 × 单价（分）定点计算。
                </div>
              </div>
            )}

            {/* 单头编辑 */}
            <Space wrap size={12}>
              {draft.customerText && !draft.customerId ? (
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>
                    客户（AI 未匹配到档案，按文本带入，可改名）
                    <Tag color="orange" style={{ marginLeft: 6, fontSize: 11 }}>未建档</Tag>
                  </div>
                  <Space.Compact>
                    <Input style={{ width: 220 }} value={draft.customerText}
                      onChange={(e) => setDraft({ ...draft, customerText: e.target.value })} />
                    <Button onClick={() => setDraft({ ...draft, customerText: undefined, customerId: undefined })}>从档案选择</Button>
                  </Space.Compact>
                  <div style={{ fontSize: 11, color: '#d46b08', marginTop: 2 }}>填入后可在「新建订单」页一键快速建档；如该客户已在档案请点「从档案选择」</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>客户 *</div>
                  <Select
                    showSearch optionFilterProp="label" style={{ width: 240 }} placeholder="选择客户"
                    value={draft.customerId} onChange={(v) => setDraft({ ...draft, customerId: v, customerText: undefined })}
                    options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  />
                </div>
              )}
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>客户 PO 号</div>
                <Input style={{ width: 160 }} value={draft.poNo} onChange={(e) => setDraft({ ...draft, poNo: e.target.value })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>交期 *</div>
                <DatePicker style={{ width: 160 }} value={draft.dueDate ? dayjs(draft.dueDate) : null}
                  onChange={(d) => setDraft({ ...draft, dueDate: d ? d.format('YYYY-MM-DD') : undefined })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>备注</div>
                <Input style={{ width: 220 }} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              </div>
            </Space>

            {/* 行编辑 */}
            <Table<EditLine>
              rowKey={(_, i) => String(i)}
              size="small" pagination={false}
              dataSource={draft.lines}
              columns={[
                {
                  title: '产品（识别名 → 目录）', width: 260,
                  render: (_, l, i) => (
                    l.productId ? (
                      <Select
                        showSearch optionFilterProp="label" style={{ width: '100%' }}
                        placeholder="选择产品"
                        value={l.productId}
                        onChange={(v) => setRow(i, { productId: v, _unmatched: false, _browse: false, productName: undefined })}
                        options={productOptions}
                      />
                    ) : l._browse ? (
                      <Select
                        showSearch optionFilterProp="label" style={{ width: '100%' }} autoFocus
                        placeholder="从目录选择产品"
                        onChange={(v) => setRow(i, { productId: v, _unmatched: false, _browse: false, productName: undefined })}
                        options={productOptions}
                      />
                    ) : (
                      <div>
                        <Space.Compact style={{ width: '100%' }}>
                          <Input
                            style={{ width: '100%' }}
                            value={l.productName ?? ''}
                            status={l._unmatched ? 'warning' : undefined}
                            placeholder="识别到的产品名（可改名）"
                            onChange={(e) => setRow(i, { productName: e.target.value })}
                          />
                        </Space.Compact>
                        <div style={{ fontSize: 11, color: l._unmatched ? '#d46b08' : '#999', marginTop: 2 }}>
                          {l._unmatched ? (
                            <>⚠ 识别为「{l.productName || '?'}」不在产品目录 —— 不改选也能填入，订单页会提示快速建档</>
                          ) : (
                            <>将按产品名文本填入（未建档），可在订单页快速建档</>
                          )}
                          <Button type="link" size="small" style={{ padding: 0, marginLeft: 6, fontSize: 11 }}
                            onClick={() => setRow(i, { _browse: true })}>改从目录选择</Button>
                        </div>
                      </div>
                    )
                  ),
                },
                {
                  title: '数量', width: 100,
                  render: (_, l, i) => (
                    <InputNumber min={1} style={{ width: '100%' }} value={l.quantity}
                      onChange={(v) => setRow(i, { quantity: v ?? undefined })} />
                  ),
                },
                {
                  title: '单价', width: 100,
                  render: (_, l, i) => (
                    <InputNumber min={0} precision={2} style={{ width: '100%' }} value={l.unitPrice}
                      onChange={(v) => setRow(i, { unitPrice: v ?? undefined })} />
                  ),
                },
                {
                  title: '币种', width: 80,
                  render: (_, l, i) => (
                    <Select style={{ width: '100%' }} value={l.currency}
                      onChange={(v) => setRow(i, { currency: v })}
                      options={[{ value: 'RMB', label: 'RMB' }, { value: 'USD', label: 'USD' }]} />
                  ),
                },
                {
                  title: '刻字', width: 130,
                  render: (_, l, i) => (
                    <Input value={l.engraving} placeholder="如 LOGO/型号" onChange={(e) => setRow(i, { engraving: e.target.value })} />
                  ),
                },
                {
                  title: '包装要求', width: 280,
                  render: (_, l, i) => (
                    <PackComboEditor value={l.packaging} onChange={(v) => setRow(i, { packaging: v })} />
                  ),
                },
                {
                  title: '', width: 40,
                  render: (_, _l, i) => (
                    <Button type="text" danger size="small" disabled={draft.lines.length <= 1}
                      onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, idx) => idx !== i) })}>删</Button>
                  ),
                },
              ]}
            />
            <div style={{ fontSize: 12, color: '#888' }}>
              确认后填入下方「新建订单」表单：命中档案的客户/产品直接选中；未建档的以文本保留并提示建档，可在表单页快速建档后保存。
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
