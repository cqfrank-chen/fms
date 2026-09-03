import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Empty, Input, List, Modal, Space, Typography, message } from 'antd'
import { PACK_LABEL } from '../lib/labels'
import { api } from '../lib/api'
import type { PackagingSpec, PackTemplate, PackType } from '../lib/types'

const PACK_TYPES = Object.keys(PACK_LABEL) as PackType[]

interface Props {
  value?: PackagingSpec | null
  onChange?: (v: PackagingSpec) => void
  disabled?: boolean
}

/**
 * 包装要求复合编辑器（受控组件，绑定 Form.Item）
 * 勾选类型（包装盒/套袋/纸箱/不干胶）→ 填规格/数量；模板库复用 / 存为模板
 */
export default function PackComboEditor({ value, onChange, disabled }: Props) {
  const pack: PackagingSpec = value ?? {}

  function toggle(t: PackType, checked: boolean) {
    const next = { ...pack }
    if (checked) next[t] = next[t] ?? ''
    else delete next[t]
    onChange?.(next)
  }
  function setSpec(t: PackType, spec: string) {
    onChange?.({ ...pack, [t]: spec })
  }
  function applyTemplate(tpl: PackagingSpec) {
    onChange?.({ ...tpl })
  }

  return (
    <Space wrap align="center" size={8}>
      {PACK_TYPES.map((t) => (
        <Space key={t} size={4} style={{
          border: pack[t] !== undefined ? '1px solid #1677ff' : '1px solid #d9d9d9',
          background: pack[t] !== undefined ? '#e6f4ff' : '#fff',
          borderRadius: 6, padding: '4px 8px',
        }}>
          <Checkbox checked={pack[t] !== undefined} disabled={disabled}
            onChange={(e) => toggle(t, e.target.checked)}>
            {PACK_LABEL[t]}
          </Checkbox>
          {pack[t] !== undefined && (
            <Input size="small" disabled={disabled} placeholder="规格/数量"
              value={pack[t] ?? ''} onChange={(e) => setSpec(t, e.target.value)}
              style={{ width: 130 }} />
          )}
        </Space>
      ))}
      <TemplateButtons apply={applyTemplate} current={pack} disabled={disabled} />
    </Space>
  )
}

/** 模板库 / 存为模板 按钮 + 弹窗 */
function TemplateButtons({ apply, current, disabled }: {
  apply: (tpl: PackagingSpec) => void
  current: PackagingSpec
  disabled?: boolean
}) {
  const [tplOpen, setTplOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [templates, setTemplates] = useState<PackTemplate[]>([])
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try { setTemplates(await api<PackTemplate[]>('/pack-templates')) } catch { /* ignore */ }
  }
  useEffect(() => { if (tplOpen) load() }, [tplOpen])

  const emptyPack = useMemo(() => Object.keys(current).length === 0, [current])

  async function saveTemplate() {
    if (!name.trim()) { message.warning('请填模板名'); return }
    if (emptyPack) { message.warning('当前行未勾选包装，无法存模板'); return }
    setSaving(true)
    try {
      await api('/pack-templates', { method: 'POST', body: { name: name.trim(), pack: current, note: note.trim() || undefined } })
      message.success('模板已保存')
      setSaveOpen(false)
      setName(''); setNote('')
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally { setSaving(false) }
  }

  return (
    <>
      <Button size="small" disabled={disabled} onClick={() => setTplOpen(true)}>模板库</Button>
      <Button size="small" disabled={disabled || emptyPack} onClick={() => setSaveOpen(true)}>+ 存为模板</Button>

      <Modal title="包装模板库（点选模板应用到本行）" open={tplOpen} footer={null}
        onCancel={() => setTplOpen(false)} width={620}>
        {templates.length === 0 ? (
          <Empty description="暂无模板 —— 在订单行勾选包装后点「+ 存为模板」" />
        ) : (
          <List
            grid={{ column: 2, gutter: 12 }}
            dataSource={templates}
            renderItem={(t) => (
              <List.Item>
                <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, cursor: 'pointer', width: '100%' }}
                  onClick={() => { apply(t.pack); setTplOpen(false); message.success(`已应用模板「${t.name}」`) }}>
                  <Typography.Text strong>{t.name}</Typography.Text>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                    {Object.entries(t.pack).map(([k, v]) => `${PACK_LABEL[k] ?? k}${v ? '：' + v : ''}`).join(' · ')}
                  </div>
                  {t.note && <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{t.note}</div>}
                </div>
              </List.Item>
            )}
          />
        )}
      </Modal>

      <Modal title="保存包装模板" open={saveOpen} onOk={saveTemplate} confirmLoading={saving}
        onCancel={() => setSaveOpen(false)} width={460}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <div style={{ marginBottom: 4 }}>模板名 *</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：Weldclass 定制盒" />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>规格说明</div>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：含 LOGO 印刷（样式图 I12 支持上传）" />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前行包装：{emptyPack ? '未勾选' : Object.entries(current).map(([k, v]) => `${PACK_LABEL[k] ?? k}${v ? '：' + v : ''}`).join(' · ')}
          </Typography.Text>
        </Space>
      </Modal>
    </>
  )
}
