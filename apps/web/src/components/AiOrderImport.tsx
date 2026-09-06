import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, DatePicker, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload, message,
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { UploadProps } from 'antd'
import dayjs from 'dayjs'
import { api } from '../lib/api'
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

interface Props {
  /** 建单成功回调（可传 orderNo 提示） */
  onCreated?: (orderNo: string) => void
}

/** 可编辑草稿行（确认建单用） */
interface EditLine {
  productId?: number; productName?: string
  quantity?: number; unitPrice?: number; currency: 'RMB' | 'USD'
  engraving?: string; packaging?: PackagingSpec
  _badProduct: boolean // AI 未匹配到目录产品 → 须人工改选
}
interface EditDraft {
  customerId?: number; poNo?: string; dueDate?: string; note?: string
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

/** AI 订单导入：图片/文本 → 解析预览（低置信标红）→ 人工修正 → 确认建单 */
export default function AiOrderImport({ onCreated }: Props) {
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
    api<Customer[]>('/customers').then(setCustomers).catch(() => {})
    api<Product[]>('/products').then(setProducts).catch(() => {})
  }, [])

  const productOptions = useMemo(
    () => products.map((p) => ({ value: p.id, label: `${p.name}（${p.type}）` })),
    [products],
  )

  /** 解析成功 → 生成可编辑草稿 */
  function openResult(r: AiResolveResult) {
    setResult(r)
    setDraft({
      customerId: r.customerId ?? undefined,
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
        _badProduct: l.productId === null,
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

  async function confirmCreate() {
    if (!draft) return
    if (!draft.customerId) { message.warning('请选择客户'); return }
    if (!draft.dueDate) { message.warning('请填写交期'); return }
    const bad = draft.lines.find((l) => !l.productId || !l.quantity || !l.unitPrice)
    if (bad) { message.warning('存在未完成的行（产品/数量/单价必填），请补全'); return }
    setSaving(true)
    try {
      const created = await api<{ orderNo: string }>('/orders', {
        method: 'POST',
        body: {
          customerId: draft.customerId,
          poNo: draft.poNo || undefined,
          dueDate: draft.dueDate,
          note: draft.note || undefined,
          lines: draft.lines.map((l) => ({
            productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
            currency: l.currency, engraving: l.engraving || undefined,
            packaging: l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined,
          })),
        },
      })
      message.success(`AI 订单已保存为草稿：${created.orderNo}（可到「订单列表」确认）`)
      onCreated?.(created.orderNo)
      // 学习闭环：解析原始稿 + 人工确认稿回流入库（few-shot 语料；静默失败）
      if (result) {
        api('/ai/feedback', {
          method: 'POST',
          body: {
            source: 'ai_import',
            parsed: result as unknown as Record<string, unknown>,
            corrected: draft as unknown as Record<string, unknown>,
            directPass: result.directPass,
          },
        }).catch(() => {})
      }
      // 建单成功 → 清除单槽草稿（I14）
      api('/ai/orders/draft', { method: 'DELETE' }).catch(() => {})
      setSaved(null)
      setResult(null); setDraft(null)
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally { setSaving(false) }
  }

  const errCount = result?.issues.filter((i) => i.level === 'error').length ?? 0

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
        <Text type="secondary" style={{ fontSize: 12 }}>支持客户邮件/微信传单/拍照图 → AI 识别成草稿，低置信字段标红人工复核（I12）</Text>
      </div>

      {/* I14：上次未提交草稿（刷新/误关自动保存，可恢复继续编辑） */}
      {saved && !draft && (
        <div style={{ border: '1px solid #ffd591', borderRadius: 8, padding: '6px 10px', marginBottom: 12, background: '#fff7e6', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text style={{ color: '#d46b08', fontSize: 13 }}>💾 有未提交的 AI 订单草稿（上次编辑于 {fmtTime(saved.updatedAt)}，已自动保存）</Text>
          <Space size={6}>
            <Button size="small" type="primary" onClick={restoreSaved}>恢复草稿</Button>
            <Button size="small" danger onClick={discardSaved}>放弃</Button>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>中途刷新/误关弹窗都不丢，确认建单后自动清除</Text>
        </div>
      )}

      {/* 文本导入 */}
      <Modal title="粘贴订单文本（邮件正文/Excel 转文本）" open={textOpen} onCancel={() => setTextOpen(false)}
        onOk={() => { if (textVal.trim()) doParse({ text: textVal.trim() }, '文本') }}
        okText="开始识别" okButtonProps={{ disabled: !textVal.trim() || busy }} width={620}>
        <Input.TextArea rows={10} value={textVal} onChange={(e) => setTextVal(e.target.value)}
          placeholder={'示例：\nCustomer: Acme Welding Co.\nPO: PO-2026-0901\nDue: 2026-10-15\n1) ANM 3  2000 pcs  USD 4.20  engrave LOGO  pack: 100/box\n2) 6290  500 pcs  USD 3.80'} />
      </Modal>

      {/* 结果预览 + 人工复核 */}
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
              {result?.directPass ? 'AI 全字段通过规则校验，可一键确认' : `尚有 ${errCount} 处红色问题需处理（见下方标红）`}
            </Text>
            <Button onClick={cancelReview}>取消</Button>
            <Button type="primary" loading={saving} disabled={errCount > 0} onClick={confirmCreate}>
              {result?.directPass ? '识别无误 · 确认建单' : '修正后确认建单'}
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
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>客户 * {result.customerMatch === 'none' && <Text type="danger" style={{ fontSize: 11 }}>（AI 未匹配，请选择/建档）</Text>}</div>
                <Select
                  showSearch optionFilterProp="label" style={{ width: 240 }} placeholder="选择客户"
                  value={draft.customerId} onChange={(v) => setDraft({ ...draft, customerId: v })}
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                />
              </div>
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
                  title: '产品（AI 识别→目录）', width: 230,
                  render: (_, l, i) => (
                    <div>
                      <Select
                        showSearch optionFilterProp="label" style={{ width: '100%' }}
                        placeholder={l._badProduct ? `⚠ ${l.productName || '未识别'}（不在目录，请改选）` : '选择产品'}
                        value={l.productId}
                        onChange={(v) => setRow(i, { productId: v, _badProduct: false })}
                        options={productOptions}
                        status={l._badProduct ? 'error' : undefined}
                      />
                      {l._badProduct && <div style={{ fontSize: 11, color: '#cf1322', marginTop: 2 }}>识别为「{l.productName || '?'}」不在产品目录，请改选或先到设置建档</div>}
                    </div>
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
                  title: '包装要求', width: 300,
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
            {draft.lines.some((l) => l.productId) && draft.lines.every((l) => !l.productId || l.packaging === undefined) && (
              <div style={{ fontSize: 12, color: '#999' }}>提示：包装未勾选类型将按「无包装要求」保存；需指定请在行内勾选（可存模板复用）</div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
