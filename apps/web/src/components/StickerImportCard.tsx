import { useState } from 'react'
import {
  Alert, Button, Card, Collapse, Descriptions, Input, InputNumber, Select, Space, Tag, Typography, Upload, message,
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { UploadProps } from 'antd'
import { api } from '../lib/api'
import { STICKER_UNIT_OPTIONS } from '../lib/labels'
import { previewStickerTitle } from '../lib/sticker-title'
import type { Sticker, StickerRecognizeResult } from '../lib/types'

const { Text, Paragraph } = Typography
const MAX_FILE = 8 * 1024 * 1024
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tif|tiff)$/i

/** 表单态（与 POST /stickers 的字段一一对应；title 留空则服务端按字段自动生成） */
interface FormState {
  title: string
  brand: string
  style: string
  sizeSpec: string
  qty: number
  unit: string
  customer: string
  remark: string
}

const EMPTY: FormState = { title: '', brand: '', style: '', sizeSpec: '', qty: 0, unit: '张', customer: '', remark: '' }

/**
 * 不干胶库存 · 上传识别建档卡片
 * ------------------------------------------------------------------
 * 流程：拖拽/选择图片 → POST /stickers/recognize（只识别不写库）→ 预览 + 可编辑字段 → 保存建档。
 * 识图不可用（Key 未配置 / 调用失败）：接口返回 ok=false + 中文提示（非 500），
 * 这里照原样展示，用户可**手工填写后直接建档**（图片已在服务端落盘，用同一个 imagePath）；
 * 全部字段来自模型或用户输入，**界面不会替用户编造任何值**。
 */
export default function StickerImportCard({ onCreated }: { onCreated?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [result, setResult] = useState<StickerRecognizeResult | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [fileName, setFileName] = useState('')

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  function reset() {
    setPreview(null); setImagePath(null); setResult(null); setForm(EMPTY); setFileName('')
  }

  /** 上传即识别（不写库）；失败也保留 imagePath，供手工建档 */
  async function recognize(dataUrl: string, name: string) {
    setBusy(true)
    try {
      const r = await api<StickerRecognizeResult>('/stickers/recognize', {
        method: 'POST',
        body: { file: dataUrl, fileName: name },
      })
      setResult(r)
      setImagePath(r.imagePath ?? null)
      const s = r.suggestion
      setForm({
        title: s?.title ?? '',
        brand: s?.brand ?? '',
        style: s?.style ?? '',
        sizeSpec: s?.sizeSpec ?? '',
        qty: s?.qty ?? 0,
        unit: s?.unit || '张',
        customer: s?.customer ?? '',
        remark: s?.remark ?? '',
      })
      if (r.ok) message.success('识别完成：请核对下方字段后保存建档')
      else message.warning(r.message ?? '识图不可用，请手工填写后建档')
    } catch (e) {
      // 网络/参数类错误（非识图通道问题）：不写入任何字段，让用户手工填写
      setResult(null); setImagePath(null); setForm(EMPTY)
      message.error('识别失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function pickFile(file: File) {
    const isImage = file.type.startsWith('image/') || IMG_EXT_RE.test(file.name)
    if (!isImage) { message.error('只支持图片文件（jpg/png/webp/gif/bmp/tif），请重新选择'); return }
    if (file.size > MAX_FILE) { message.error('图片超过 8MB，请压缩后重试'); return }
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      setPreview(dataUrl)
      void recognize(dataUrl, file.name)
    }
    reader.onerror = () => message.error('图片读取失败，请重新选择')
    reader.readAsDataURL(file)
  }

  const uploadProps: UploadProps = {
    accept: 'image/*',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      pickFile(file as unknown as File)
      return false // 阻止自动上传：统一转 dataURL 直送
    },
  }

  const auto = previewStickerTitle(form)
  const canSave = !!(
    imagePath || preview
    || form.brand.trim() || form.style.trim() || form.sizeSpec.trim() || form.title.trim()
  )

  async function save() {
    setSaving(true)
    try {
      const created = await api<Sticker>('/stickers', {
        method: 'POST',
        body: {
          imagePath: imagePath ?? undefined,
          title: form.title.trim() || undefined,
          brand: form.brand || undefined,
          style: form.style || undefined,
          sizeSpec: form.sizeSpec || undefined,
          qty: form.qty ?? 0,
          unit: form.unit || '张',
          customer: form.customer || undefined,
          remark: form.remark || undefined,
          rawText: result?.suggestion?.rawText || undefined,
          // 识图不可用时把中文提示写进备注留痕（人工复核时知道「这批没有 AI 参与」）
          aiNote: result && !result.ok ? result.message : undefined,
        },
      })
      message.success('已建档：' + created.title + '（库存 ' + created.qty + ' ' + created.unit + '）')
      reset()
      onCreated?.()
    } catch (e) {
      message.error('建档失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      size="small"
      title="上传不干胶图片 · 识别建档"
      extra={<Text type="secondary" style={{ fontSize: 12 }}>识别只做建议、不写库；确认后保存才建档</Text>}
    >
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <Upload.Dragger {...uploadProps} disabled={busy}>
          <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}><InboxOutlined /></p>
          <p className="ant-upload-text" style={{ fontSize: 14 }}>
            {busy ? '正在识别图片…' : '点击选择或把不干胶图片拖到这里'}
          </p>
          <p className="ant-upload-hint" style={{ fontSize: 12 }}>
            jpg / png / webp / gif / bmp / tif，单文件 ≤ 8MB；识别结果需人工核对，缺项会写进备注，绝不臆造。
          </p>
        </Upload.Dragger>

        {/* 识图通道不可用：中文提示 + 手工建档指引（HTTP 200，不是 500） */}
        {result && !result.ok && (
          <Alert
            type="warning"
            showIcon
            message={result.code === 'VISION_KEY_MISSING' ? '识图 Key 未配置' : '识图未能完成'}
            description={
              <span>
                {result.message}
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  图片已保存，下面的字段可以手工填写后直接「保存建档」；不会写入任何编造的识别值。
                </Text>
              </span>
            }
          />
        )}
        {result?.ok && result.suggestion?.note && (
          <Alert type="info" showIcon message={result.suggestion.note} style={{ fontSize: 12 }} />
        )}

        {(preview || imagePath) && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {preview
              ? <img src={preview} alt="待建档不干胶" style={{ maxWidth: 240, maxHeight: 240, border: '1px solid #eee', borderRadius: 6 }} />
              : <Text type="secondary">图片已保存在服务端（预览从略）</Text>}
            <div style={{ flex: 1, minWidth: 320 }}>
              <Space wrap size={10} style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {fileName ? '文件：' + fileName : '图片已入库待保存'}
                </Text>
                {imagePath && <Tag color="blue">图片已落盘</Tag>}
                <Button size="small" onClick={reset} disabled={saving}>重新选择</Button>
              </Space>
              <div style={{ fontSize: 12, color: '#888' }}>
                识别建议标题：<Text strong>{auto.title}</Text>
                {auto.missing.length > 0 && <span style={{ color: '#d46b08' }}>（缺：{auto.missing.join('、')}）</span>}
              </div>
            </div>
          </div>
        )}

        {(preview || imagePath || result) && (
          <>
            <Space wrap size={12} align="start">
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>库存标题（可改；留空则按字段自动生成）</div>
                <Space.Compact>
                  <Input
                    style={{ width: 300 }} value={form.title} placeholder={auto.title}
                    onChange={(e) => set({ title: e.target.value })}
                  />
                  <Button onClick={() => set({ title: auto.title })}>按字段生成</Button>
                </Space.Compact>
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>品牌</div>
                <Input style={{ width: 160 }} value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>样式 / 系列</div>
                <Input style={{ width: 160 }} value={form.style} onChange={(e) => set({ style: e.target.value })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>规格 / 尺寸</div>
                <Input style={{ width: 160 }} value={form.sizeSpec} onChange={(e) => set({ sizeSpec: e.target.value })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>数量</div>
                <InputNumber min={0} style={{ width: 110 }} value={form.qty} onChange={(v) => set({ qty: v ?? 0 })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>单位</div>
                <Select style={{ width: 90 }} value={form.unit} options={STICKER_UNIT_OPTIONS} onChange={(v) => set({ unit: v })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>所属客户 / 文件夹</div>
                <Input style={{ width: 200 }} value={form.customer} placeholder="可空（通用）" onChange={(e) => set({ customer: e.target.value })} />
              </div>
            </Space>
            <div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>备注（缺项说明 / 颜色 / 材质 / 贴法）</div>
              <Input.TextArea rows={2} value={form.remark} onChange={(e) => set({ remark: e.target.value })} />
            </div>
          </>
        )}

        {/* AI 提取原文（复核追溯；随建档写入 rawText 字段） */}
        {result?.suggestion?.rawText && (
          <Collapse
            size="small"
            items={[{
              key: 'raw',
              label: 'AI 提取原文（复核用，会随记录留痕）',
              children: <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0, fontSize: 12 }}>{result.suggestion.rawText}</Paragraph>,
            }]}
          />
        )}

        <Space>
          <Button type="primary" loading={saving} disabled={!canSave} onClick={save}>保存建档</Button>
          <Button onClick={reset} disabled={saving || busy}>清空</Button>
          {!!imagePath && (
            <Descriptions size="small" column={1} style={{ marginBottom: 0 }}>
              <Descriptions.Item label="图片路径">
                <Text code style={{ fontSize: 11 }}>{imagePath}</Text>
              </Descriptions.Item>
            </Descriptions>
          )}
        </Space>
      </Space>
    </Card>
  )
}
