import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Descriptions, Empty, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { STICKER_ADJUST_LABEL, STICKER_UNIT_OPTIONS } from '../lib/labels'
import { invalidateStickerImage, useStickerImage } from '../lib/sticker-image'
import type { Sticker, StickerAdjustment, StickerList } from '../lib/types'

const { Text } = Typography

const fmt = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—')

/**
 * 不干胶库存 · 图片缩略图（走登录态取图：<img src> 不会带 Authorization 头）
 * version 变化（重新上传图片）时重新拉取。
 */
function StickerThumb({ id, version, size = 64, onClick }: { id: number; version: number; size?: number; onClick?: () => void }) {
  const { url, error, loading } = useStickerImage(id, version)
  if (error) return <Text type="secondary" style={{ fontSize: 11 }}>取图失败</Text>
  if (!url) {
    return (
      <div style={{ width: size, height: size, background: '#f5f5f5', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>{loading ? '…' : '无图'}</Text>
      </div>
    )
  }
  return (
    <img
      src={url} alt={'不干胶 ' + id} width={size} height={size}
      onClick={onClick}
      style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #eee', cursor: onClick ? 'zoom-in' : 'default' }}
    />
  )
}

/** 大图（详情弹窗用） */
function StickerLarge({ id, version }: { id: number; version: number }) {
  const { url, error } = useStickerImage(id, version)
  if (error) return <Alert type="warning" showIcon message="图片加载失败（可能已被清理），请重新上传" />
  if (!url) return <Text type="secondary">加载中…</Text>
  return <img src={url} alt="不干胶大图" style={{ maxWidth: '100%', maxHeight: 420, border: '1px solid #eee', borderRadius: 6 }} />
}

/**
 * 不干胶库存列表
 * ------------------------------------------------------------------
 * · 关键词 / 品牌 / 客户 筛选 + 服务端分页；
 * · 缩略图（点击看大图）、标题（点击看详情 + 出入库流水）；
 * · 数量维护**就地操作**：行内「入库 / 领用」按钮 → 小弹窗填数量与备注 → 写流水留痕。
 */
export default function StickersPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<Sticker[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [kw, setKw] = useState('')
  const [brand, setBrand] = useState<string | undefined>(undefined)
  const [customer, setCustomer] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState(0)

  // 弹窗状态
  const [detail, setDetail] = useState<Sticker | null>(null)
  const [editing, setEditing] = useState<Sticker | null>(null)
  const [adjusting, setAdjusting] = useState<{ sticker: Sticker; kind: 'in' | 'out' } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (kw.trim()) qs.set('kw', kw.trim())
      if (brand) qs.set('brand', brand)
      if (customer.trim()) qs.set('customer', customer.trim())
      qs.set('page', String(page))
      qs.set('pageSize', String(pageSize))
      const r = await api<StickerList>('/stickers?' + qs.toString())
      setRows(r.rows)
      setTotal(r.total)
    } catch (e) {
      message.error('不干胶列表加载失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [kw, brand, customer, page, pageSize])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    api<string[]>('/stickers/brands')
      .then(setBrands)
      .catch(() => setBrands([]))
  }, [version])

  /** 变更后统一刷新（顺带让缩略图重新取图） */
  const refresh = useCallback(() => {
    setVersion((v) => v + 1)
    void load()
    onChanged?.()
  }, [load, onChanged])

  const resetFilters = () => { setKw(''); setBrand(undefined); setCustomer(''); setPage(1) }

  const columns = useMemo<ColumnsType<Sticker>>(() => [
    {
      title: '图片', width: 84,
      render: (_, s) => (
        <StickerThumb id={s.id} version={version} size={64} onClick={() => setDetail(s)} />
      ),
    },
    {
      title: '标题', dataIndex: 'title', width: 240,
      render: (v: string, s) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0, textAlign: 'left', whiteSpace: 'normal', height: 'auto' }} onClick={() => setDetail(s)}>{v}</Button>
          {s.operatorName && <Text type="secondary" style={{ fontSize: 11 }}>经办：{s.operatorName}</Text>}
        </Space>
      ),
    },
    { title: '品牌', dataIndex: 'brand', width: 120, render: (v?: string) => v || '—' },
    { title: '样式 / 系列', dataIndex: 'style', width: 140, render: (v?: string) => v || '—' },
    { title: '规格 / 尺寸', dataIndex: 'sizeSpec', width: 130, render: (v?: string) => v || '—' },
    {
      title: '数量', width: 110, align: 'right',
      render: (_, s) => (
        <Text strong style={{ color: s.qty > 0 ? undefined : '#cf1322' }}>{s.qty} {s.unit}</Text>
      ),
    },
    { title: '客户', dataIndex: 'customer', width: 140, render: (v?: string) => v || <Text type="secondary">通用</Text> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => fmt(v) },
    {
      title: '操作', width: 210, fixed: 'right',
      render: (_, s) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => setAdjusting({ sticker: s, kind: 'in' })}>入库</Button>
          <Button size="small" onClick={() => setAdjusting({ sticker: s, kind: 'out' })}>领用</Button>
          <Button size="small" type="link" onClick={() => setEditing(s)}>编辑</Button>
        </Space>
      ),
    },
  ], [version])

  return (
    <Card
      size="small"
      title="不干胶库存列表"
      extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {total} 条</Text>}
    >
      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Input.Search
          style={{ width: 240 }} allowClear placeholder="搜索标题/品牌/样式/规格/备注"
          value={kw} onChange={(e) => setKw(e.target.value)}
          onSearch={() => { setPage(1); void load() }}
        />
        <Select
          style={{ width: 160 }} allowClear placeholder="品牌筛选" value={brand}
          options={brands.map((b) => ({ value: b, label: b }))}
          onChange={(v) => { setBrand(v); setPage(1) }}
        />
        <Input
          style={{ width: 180 }} allowClear placeholder="客户 / 文件夹"
          value={customer} onChange={(e) => setCustomer(e.target.value)}
          onPressEnter={() => { setPage(1); void load() }}
        />
        <Button type="primary" onClick={() => { setPage(1); void load() }}>查询</Button>
        <Button icon={<ReloadOutlined />} onClick={resetFilters}>重置</Button>
      </Space>

      <Table<Sticker>
        rowKey="id" size="small" loading={loading} dataSource={rows} columns={columns}
        scroll={{ x: 1300 }}
        locale={{ emptyText: <Empty description="暂无库存记录：到上方「上传不干胶图片 · 识别建档」新建" /> }}
        pagination={{
          current: page, pageSize, total, showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps) },
        }}
      />

      {detail && (
        <StickerDetailModal
          sticker={detail} version={version}
          onClose={() => setDetail(null)}
          onChanged={() => { refresh() }}
        />
      )}
      {editing && (
        <StickerEditModal
          sticker={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => { invalidateStickerImage(id); setEditing(null); refresh() }}
        />
      )}
      {adjusting && (
        <StickerAdjustModal
          sticker={adjusting.sticker} kind={adjusting.kind}
          onClose={() => setAdjusting(null)}
          onDone={() => { setAdjusting(null); refresh() }}
        />
      )}
    </Card>
  )
}

/** 数量调整弹窗（就地入库/领用；写流水留痕） */
function StickerAdjustModal({ sticker, kind, onClose, onDone }: {
  sticker: Sticker
  kind: 'in' | 'out'
  onClose: () => void
  onDone: () => void
}) {
  const [qty, setQty] = useState<number>(1)
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)
  const after = kind === 'in' ? sticker.qty + (qty || 0) : sticker.qty - (qty || 0)

  async function submit() {
    if (!qty || qty <= 0) { message.warning('数量须为正整数'); return }
    setBusy(true)
    try {
      const r = await api<{ sticker: Sticker }>(`/stickers/${sticker.id}/adjust`, {
        method: 'POST',
        body: { kind, qty, remark: remark.trim() || undefined },
      })
      message.success(`${STICKER_ADJUST_LABEL[kind]} ${qty} ${sticker.unit} 成功：库存 ${r.sticker.qty} ${r.sticker.unit}`)
      onDone()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open title={`${STICKER_ADJUST_LABEL[kind]} · ${sticker.title}`}
      onCancel={onClose} onOk={submit} okText="确认" confirmLoading={busy}
      okButtonProps={{ danger: kind === 'out' }}
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="当前库存">{sticker.qty} {sticker.unit}</Descriptions.Item>
          <Descriptions.Item label="调整后">
            <Text strong style={{ color: after < 0 ? '#cf1322' : undefined }}>{after} {sticker.unit}</Text>
          </Descriptions.Item>
        </Descriptions>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>本次数量（{STICKER_ADJUST_LABEL[kind]}）</div>
          <InputNumber min={1} style={{ width: 160 }} value={qty} onChange={(v) => setQty(v ?? 1)} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>备注（用途 / 单号 / 领用人，写入流水留痕）</div>
          <Input.TextArea rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} />
        </div>
        {after < 0 && <Alert type="error" showIcon message="库存不足：领用数量不能超过当前库存" />}
      </Space>
    </Modal>
  )
}

/** 编辑弹窗（可换图；标题留空按字段自动生成） */
function StickerEditModal({ sticker, onClose, onSaved }: {
  sticker: Sticker
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const [form, setForm] = useState({
    title: sticker.title, brand: sticker.brand ?? '', style: sticker.style ?? '',
    sizeSpec: sticker.sizeSpec ?? '', unit: sticker.unit || '张',
    customer: sticker.customer ?? '', remark: sticker.remark ?? '',
  })
  const [file, setFile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  async function submit() {
    setBusy(true)
    try {
      await api(`/stickers/${sticker.id}`, {
        method: 'PUT',
        body: {
          title: form.title.trim(),
          brand: form.brand, style: form.style, sizeSpec: form.sizeSpec,
          unit: form.unit, customer: form.customer, remark: form.remark,
          ...(file ? { file } : {}),
        },
      })
      message.success('已保存')
      onSaved(sticker.id)
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open title={'编辑 · ' + sticker.title} onCancel={onClose} onOk={submit} okText="保存" confirmLoading={busy} width={620}>
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>库存标题</div>
          <Input value={form.title} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <Space wrap size={10}>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>品牌</div>
            <Input style={{ width: 150 }} value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>样式 / 系列</div>
            <Input style={{ width: 150 }} value={form.style} onChange={(e) => set({ style: e.target.value })} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>规格 / 尺寸</div>
            <Input style={{ width: 150 }} value={form.sizeSpec} onChange={(e) => set({ sizeSpec: e.target.value })} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>单位</div>
            <Select style={{ width: 90 }} value={form.unit} options={STICKER_UNIT_OPTIONS} onChange={(v) => set({ unit: v })} />
          </div>
        </Space>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>所属客户 / 文件夹</div>
          <Input value={form.customer} onChange={(e) => set({ customer: e.target.value })} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>备注</div>
          <Input.TextArea rows={3} value={form.remark} onChange={(e) => set({ remark: e.target.value })} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>换图（可选；不选则保留原图）</div>
          <Space align="center">
            <Upload
              accept="image/*" showUploadList={false} maxCount={1}
              beforeUpload={(f) => {
                const raw = f as unknown as File
                if (raw.size > 8 * 1024 * 1024) { message.error('图片超过 8MB'); return false }
                const reader = new FileReader()
                reader.onload = () => setFile(String(reader.result))
                reader.readAsDataURL(raw)
                return false
              }}
            >
              <Button>选择新图片</Button>
            </Upload>
            {file && <Tag color="blue">已选新图，保存后替换</Tag>}
          </Space>
        </div>
        {!form.title.trim() && (
          <Alert type="info" showIcon message="标题留空：保存时按 品牌 + 样式/系列 + 规格 自动生成（缺项省略）" style={{ fontSize: 12 }} />
        )}
      </Space>
    </Modal>
  )
}

/** 详情弹窗：大图 + 全部字段 + 出入库流水 */
function StickerDetailModal({ sticker, version, onClose, onChanged }: {
  sticker: Sticker
  version: number
  onClose: () => void
  onChanged: () => void
}) {
  const [moves, setMoves] = useState<StickerAdjustment[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api<StickerAdjustment[]>(`/stickers/${sticker.id}/adjustments?limit=50`)
      .then(setMoves)
      .catch(() => setMoves([]))
      .finally(() => setLoading(false))
  }, [sticker.id, version])

  return (
    <Modal open title={'不干胶详情 · ' + sticker.title} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={820}>
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <div style={{ textAlign: 'center', background: '#fafafa', padding: 10, borderRadius: 6 }}>
          {sticker.imagePath
            ? <StickerLarge id={sticker.id} version={version} />
            : <Text type="secondary">该记录没有上传图片</Text>}
        </div>
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="标题" span={2}>{sticker.title}</Descriptions.Item>
          <Descriptions.Item label="品牌">{sticker.brand || '—'}</Descriptions.Item>
          <Descriptions.Item label="样式 / 系列">{sticker.style || '—'}</Descriptions.Item>
          <Descriptions.Item label="规格 / 尺寸">{sticker.sizeSpec || '—'}</Descriptions.Item>
          <Descriptions.Item label="库存">
            <Text strong style={{ color: sticker.qty > 0 ? undefined : '#cf1322' }}>{sticker.qty} {sticker.unit}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="客户 / 文件夹">{sticker.customer || '通用'}</Descriptions.Item>
          <Descriptions.Item label="经办人">{sticker.operatorName || '—'}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{fmt(sticker.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{fmt(sticker.updatedAt)}</Descriptions.Item>
          <Descriptions.Item label="图片路径" span={2}>
            <Text code style={{ fontSize: 11 }}>{sticker.imagePath || '—'}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="备注" span={2}>
            <span style={{ whiteSpace: 'pre-wrap' }}>{sticker.remark || '—'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="AI 提取原文" span={2}>
            <span style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{sticker.rawText || '—'}</span>
          </Descriptions.Item>
        </Descriptions>

        <div>
          <Text strong>入库 / 领用流水</Text>
          <Table<StickerAdjustment>
            rowKey="id" size="small" loading={loading} dataSource={moves} pagination={false}
            style={{ marginTop: 8 }}
            locale={{ emptyText: '暂无调整流水（未做过出入库）' }}
            columns={[
              { title: '时间', dataIndex: 'createdAt', width: 150, render: (v?: string) => fmt(v) },
              { title: '类型', dataIndex: 'kind', width: 80, render: (v: string) => <Tag color={v === 'in' ? 'green' : 'orange'}>{STICKER_ADJUST_LABEL[v] ?? v}</Tag> },
              { title: '变动量', dataIndex: 'qtyDelta', width: 90, align: 'right', render: (v: number) => (v > 0 ? '+' + v : String(v)) },
              { title: '变动前', dataIndex: 'qtyBefore', width: 80, align: 'right' },
              { title: '变动后', dataIndex: 'qtyAfter', width: 80, align: 'right' },
              { title: '经办人', dataIndex: 'operatorName', width: 100, render: (v?: string) => v || '—' },
              { title: '备注', dataIndex: 'remark', render: (v?: string) => v || '—' },
            ]}
          />
        </div>
        <Button size="small" onClick={onChanged}>刷新</Button>
      </Space>
    </Modal>
  )
}
