import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, DatePicker, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload, message,
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { UploadProps } from 'antd'
import dayjs from 'dayjs'
import { api, loadOptions } from '../lib/api'
import type { Customer, PackagingSpec, Product } from '../lib/types'
import PackComboEditor from './PackComboEditor'

const { Text } = Typography
const MAX_IMG = 8 * 1024 * 1024 // 8MB（nginx/后端 12mb 内）

// ===== 后端 /api/ai/orders/parse 的返回结构（与 order-parser.service 对齐）=====
export interface AiIssue { path: string; level: 'error' | 'warn'; message: string }
export interface AiParsedLine {
  productName: string; productId: number | null; match: 'exact' | 'none'
  quantity?: number; unitPrice?: number; currency?: 'RMB' | 'USD'
  engraving?: string; packaging?: PackagingSpec; issues: AiIssue[]
}
export interface AiResolveResult {
  customerId: number | null; customerName: string; customerMatch: 'exact' | 'none'
  poNo?: string; dueDate?: string; note?: string
  lines: AiParsedLine[]; issues: AiIssue[]
  confidence: 'high' | 'low'; notes: string[]
  directPass: boolean
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

const todayStr = () => dayjs().format('YYYY-MM-DD')
const fmtTime = (iso: string) => dayjs(iso).format('MM-DD HH:mm')

/** 后端单槽草稿（I14：GET/POST/DELETE /ai/orders/draft） */
interface SavedDraft {
  result: AiResolveResult
  draft: EditDraft
  updatedAt: string
}

/** AI 订单导入：图片/文本 → 解析预览（低置信标红）→ 人工修正 → 填入新建订单表单（建档/保存由订单页承接） */
export default function AiOrderImport({ onReviewDone }: Props) {
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

  async function doParse(body: { text?: string; image?: string }, from: string) {
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

  // ---- 图片上传：转 dataURL 直送（不经 multipart）----
  const uploadProps: UploadProps = {
    accept: 'image/*',
    showUploadList: false,
    beforeUpload: (file) => {
      if (!file.type.startsWith('image/')) { message.warning('请上传图片文件'); return Upload.LIST_IGNORE }
      if (file.size > MAX_IMG) { message.warning('图片超过 8MB，请压缩后再试'); return Upload.LIST_IGNORE }
      const reader = new FileReader()
      reader.onload = () => doParse({ image: String(reader.result) }, '图片')
      reader.onerror = () => message.error('图片读取失败')
      reader.readAsDataURL(file)
      return false // 阻止自动上传
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

  const unmatchedCount = draft?.lines.filter((l) => l._unmatched).length ?? 0
  const customerUnmatched = !!draft?.customerText && !draft.customerId

  return (
    <>
      <div style={{ border: '1px dashed #91caff', borderRadius: 8, padding: 10, marginBottom: 16, background: '#f0f7ff', display: 'flex', alignItems: 'center', gap: 16 }}>
        <Text strong style={{ color: '#0958d9' }}>📷 AI 导入订单</Text>
        <Space size={8}>
          <Upload {...uploadProps} disabled={busy}>
            <Button size="small" type="primary" ghost loading={busy} icon={<InboxOutlined />}>上传订单图片</Button>
          </Upload>
          <Button size="small" loading={busy} onClick={() => setTextOpen(true)}>粘贴订单文本</Button>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>支持客户邮件/微信传单/拍照图 → AI 识别成草稿，低置信字段标红人工复核</Text>
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
        title={<>AI 识别结果 · 订单草稿 <Tag color={result?.directPass ? 'green' : result?.confidence === 'low' ? 'orange' : 'blue'}>
          {result?.directPass ? '可直接确认' : result?.confidence === 'low' ? '低置信·需复核' : '需复核'}
        </Tag></>}
        open={!!result && !!draft}
        onCancel={cancelReview}
        width={980}
        footer={
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {customerUnmatched || unmatchedCount > 0
                ? `${customerUnmatched ? '客户 1 个、' : ''}${unmatchedCount} 个产品不在档案 —— 可在下方新建订单页一键快速建档，这里不做限制`
                : result?.directPass ? 'AI 全字段通过规则校验，可一键填入' : '按识别结果填入，可在新建订单页继续修正'}
            </Text>
            <Button onClick={cancelReview}>取消</Button>
            <Button type="primary" loading={saving} onClick={confirmFill}>
              按识别结果填入新建订单
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
