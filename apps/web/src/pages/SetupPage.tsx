import { Button, Card, Divider, Form, Input, Popconfirm, Space, Tag, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import CrudResource from '../components/CrudResource'
import type { FieldConfig } from '../components/CrudResource'
import { PRODUCT_TYPE_LABEL, SETTLEMENT_LABEL } from '../lib/labels'
import { api } from '../lib/api'
import type { ColumnsType } from 'antd/es/table'

const { Text } = Typography

const PRODUCT_TYPE_OPTIONS = Object.entries(PRODUCT_TYPE_LABEL).map(([value, label]) => ({ value, label }))
const SETTLEMENT_OPTIONS = Object.entries(SETTLEMENT_LABEL).map(([value, label]) => ({ value, label }))

interface ProductRow { id: number; name: string; type: string; defaultPackaging?: string | null; defaultRouting?: string | null; safetyStock: number }
interface CustomerRow { id: number; name: string; contact?: string | null; settlement?: string | null; creditDays: number }
interface SupplierRow { id: number; name: string; contact?: string | null; settlement?: string | null }
interface OperatorRow { id: number; name: string; boundPc?: string | null; note?: string | null }

const PRODUCT_COLUMNS: ColumnsType<ProductRow> = [
  { title: '产品', dataIndex: 'name' },
  { title: '类型', dataIndex: 'type', width: 110, render: (v: string) => PRODUCT_TYPE_LABEL[v] ?? v },
  { title: '默认包装', dataIndex: 'defaultPackaging', render: (v?: string | null) => v || '—' },
  { title: '默认工序路线', dataIndex: 'defaultRouting', render: (v?: string | null) => v || '—' },
  { title: '安全库存', dataIndex: 'safetyStock', width: 90, align: 'right' },
]

const CUSTOMER_COLUMNS: ColumnsType<CustomerRow> = [
  { title: '客户', dataIndex: 'name' },
  { title: '联系人', dataIndex: 'contact', render: (v?: string | null) => v || '—' },
  { title: '结算方式', dataIndex: 'settlement', width: 190, render: (v?: string | null) => (v ? SETTLEMENT_LABEL[v] ?? v : '—') },
  { title: '账期（天）', dataIndex: 'creditDays', width: 100, align: 'right' },
]

const SUPPLIER_COLUMNS: ColumnsType<SupplierRow> = [
  { title: '供应商', dataIndex: 'name' },
  { title: '联系人', dataIndex: 'contact', render: (v?: string | null) => v || '—' },
  { title: '结算方式', dataIndex: 'settlement', width: 190, render: (v?: string | null) => (v ? SETTLEMENT_LABEL[v] ?? v : '—') },
]

const OPERATOR_COLUMNS: ColumnsType<OperatorRow> = [
  { title: '操作人', dataIndex: 'name' },
  { title: '绑定 PC', dataIndex: 'boundPc', width: 170, render: (v?: string | null) => v || '不绑定（机动）' },
  { title: '备注', dataIndex: 'note', render: (v?: string | null) => v || '—' },
]

const PRODUCT_FIELDS: FieldConfig[] = [
  { name: 'name', label: '产品名', required: true, placeholder: '如：ANM 1/32" 乙炔' },
  { name: 'type', label: '类型', required: true, kind: 'select', options: PRODUCT_TYPE_OPTIONS },
  { name: 'defaultPackaging', label: '默认包装', placeholder: '如：包装盒×50+纸箱' },
  { name: 'defaultRouting', label: '默认工序路线', placeholder: '如：下料→车削→钻孔→螺纹→铰孔→抛光→清洗→测试→包装' },
  { name: 'safetyStock', label: '安全库存', kind: 'number', min: 0 },
]

const CUSTOMER_FIELDS: FieldConfig[] = [
  { name: 'name', label: '客户名', required: true, placeholder: '如：Weldclass（澳洲）' },
  { name: 'contact', label: '联系人', placeholder: '如：John' },
  { name: 'settlement', label: '结算方式', kind: 'select', options: SETTLEMENT_OPTIONS },
  { name: 'creditDays', label: '账期天数', kind: 'number', min: 0 },
]

const SUPPLIER_FIELDS: FieldConfig[] = [
  { name: 'name', label: '供应商名', required: true, placeholder: '如：桐乡铜业' },
  { name: 'contact', label: '联系人', placeholder: '如：王经理' },
  { name: 'settlement', label: '结算方式', kind: 'select', options: SETTLEMENT_OPTIONS },
]

const OPERATOR_FIELDS: FieldConfig[] = [
  { name: 'name', label: '操作人姓名', required: true, placeholder: '如：文员' },
  { name: 'boundPc', label: '绑定 PC', placeholder: '如：办公室1号机（空=机动）' },
  { name: 'note', label: '备注', placeholder: '如：订单录入/计划单审核' },
]

/** 界面顶端展示四实体数量汇总 */
function EntityStats() {
  const [stats, setStats] = useState<Record<string, number>>({})
  useEffect(() => {
    ;(async () => {
      try {
        const [p, c, s, o] = await Promise.all([
          api<ProductRow[]>('/products'),
          api<CustomerRow[]>('/customers'),
          api<SupplierRow[]>('/suppliers'),
          api<OperatorRow[]>('/operators'),
        ])
        setStats({ 产品: p.length, 客户: c.length, 供应商: s.length, 操作人: o.length })
      } catch { /* 空态 */ }
    })()
  }, [])
  return (
    <Space wrap>
      {Object.entries(stats).map(([k, v]) => (
        <Typography.Text key={k} type="secondary">{k} {v} 条</Typography.Text>
      ))}
    </Space>
  )
}

/** 设置页：主数据四实体（spec §3）+ AI 服务配置，列表 + 弹窗直接生效 */
export default function SetupPage() {
  return (
    <div style={{ maxWidth: 1240 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>主数据（设置）</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        订单/计划单/排期/仓储/账目的唯一引用来源。直接生效无草稿态。
      </Typography.Paragraph>
      <EntityStats />
      <div style={{ display: 'grid', gap: 16, marginTop: 12 }}>
        <CrudResource<ProductRow>
          title="产品目录"
          resource="products"
          columns={PRODUCT_COLUMNS}
          fields={PRODUCT_FIELDS}
          initialValues={{ safetyStock: 0 }}
        />
        <CrudResource<CustomerRow>
          title="客户档案"
          resource="customers"
          columns={CUSTOMER_COLUMNS}
          fields={CUSTOMER_FIELDS}
          initialValues={{ creditDays: 30 }}
        />
        <CrudResource<SupplierRow>
          title="供应商档案"
          resource="suppliers"
          columns={SUPPLIER_COLUMNS}
          fields={SUPPLIER_FIELDS}
        />
        <CrudResource<OperatorRow>
          title="操作人（固定名单 / PC 绑定）"
          resource="operators"
          columns={OPERATOR_COLUMNS}
          fields={OPERATOR_FIELDS}
        />
        <AiConfigCard />
      </div>
    </div>
  )
}

// =============== AI 服务配置（运行时改，DB 优先 .env，保存立即生效） ===============
interface AiFieldState { keySet?: boolean; keyHint?: string; value?: string; default?: string }
type AiConfigResp = Record<string, AiFieldState>

function AiConfigCard() {
  const [cfg, setCfg] = useState<AiConfigResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<'chat' | 'vision' | null>(null)
  const [input, setInput] = useState<Record<string, string>>({})

  const load = async () => {
    try {
      setCfg(await api<AiConfigResp>('/ai/config'))
    } catch {
      message.error('加载 AI 配置失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const s = (f: string) => cfg?.[f]
  const chatOk = !!cfg?.chatApiKey?.keySet
  const visOk = !!cfg?.visionApiKey?.keySet

  const save = async () => {
    const patch: Record<string, string> = {}
    for (const [f, v] of Object.entries(input)) {
      const cur = f.endsWith('ApiKey') ? '' : (s(f)?.value ?? '')
      if (v.trim() && v.trim() !== cur) patch[f] = v.trim()
    }
    if (!Object.keys(patch).length) {
      message.info('没有需要保存的改动（输入框留空 = 不改动）')
      return
    }
    setSaving(true)
    try {
      await api('/ai/config', { method: 'POST', body: JSON.stringify(patch) })
      message.success('已保存并立即生效（无需重启）')
      setInput({})
      await load()
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const clearField = async (f: string) => {
    try {
      await api('/ai/config', { method: 'POST', body: JSON.stringify({ [f]: '' }) })
      message.success('已清除，回退默认配置')
      setInput((p) => ({ ...p, [f]: '' }))
      await load()
    } catch {
      message.error('清除失败')
    }
  }

  const test = async (kind: 'chat' | 'vision') => {
    if (kind === 'chat' && !chatOk) { message.warning('请先填写并保存对话 API Key'); return }
    if (kind === 'vision' && !visOk) { message.warning('请先填写并保存识图 API Key'); return }
    setTesting(kind)
    try {
      const r = await api<{ ok: boolean; message: string }>('/ai/test', { method: 'POST', body: JSON.stringify({ kind }) })
      if (r.ok) message.success(r.message)
      else message.error('连接失败：' + r.message)
    } catch {
      message.error('测试请求失败')
    } finally {
      setTesting(null)
    }
  }

  const inputProps = (f: string, ph: string, isKey = false) => {
    const st = s(f)
    const isKeyConfigured = isKey ? !!st?.keySet : !!(st?.value ?? '')
    const shown = isKey ? (st?.keyHint ? `当前已配置 ${st.keyHint}（留空=不改动）` : '未配置（留空=不改动）') : `${ph}（当前：${st?.value ?? '默认 ' + (st?.default ?? '')}；留空=不改动）`
    return {
      value: input[f] ?? '',
      placeholder: shown,
      status: (isKeyConfigured ? undefined : 'warning') as 'warning' | undefined,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInput((p) => ({ ...p, [f]: e.target.value })),
      style: { width: 380 },
      disabled: loading,
      ...(isKey ? { type: 'password' as const, autoComplete: 'new-password' } : {}),
    }
  }

  const fieldRow = (f: string, label: string, ph: string, isKey = false) => {
    const st = s(f)
    const configured = isKey ? !!st?.keySet : !!st?.value
    return (
      <Space key={f} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ width: 110, fontSize: 13, color: '#666' }}>{label}</div>
        <Input {...inputProps(f, ph, isKey)} />
        {isKey && configured && (
          <Popconfirm title="清除后回退默认（.env）配置？" onConfirm={() => clearField(f)} okText="清除" okButtonProps={{ danger: true }}>
            <Button size="small" type="link" danger>清除</Button>
          </Popconfirm>
        )}
      </Space>
    )
  }

  return (
    <Card
      title={
        <Space>
          AI 服务配置
          <Tag color={chatOk ? 'success' : 'default'}>{chatOk ? '对话已配置' : '对话未配置'}</Tag>
          <Tag color={visOk ? 'success' : 'default'}>{visOk ? '识图已配置' : '识图未配置'}</Tag>
        </Space>
      }
      size="small"
      loading={loading}
      extra={<Button size="small" onClick={load} icon={<span>↻</span>}>刷新</Button>}
    >
      <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
        在系统内直接填写/修改，保存立即生效无需重启（存于系统数据库，优先于 .env；输入框留空 = 不改动）
      </div>
      <Form layout="vertical" style={{ maxWidth: 720 }}>
        <Typography.Text strong>💬 对话 AI（订单解析文本 / 查数问答 / 报表摘要）</Typography.Text>
        <div style={{ margin: '10px 0 16px' }}>
          {fieldRow('chatApiKey', 'API Key', 'sk-…', true)}
          {fieldRow('chatBaseUrl', '接口地址', 'https://api.deepseek.com/v1')}
          {fieldRow('chatModel', '模型', 'deepseek-chat')}
          <Button size="small" loading={testing === 'chat'} onClick={() => test('chat')} style={{ marginTop: 6 }}>测试对话连接</Button>
        </div>
        <Divider style={{ margin: '8px 0 12px' }} />
        <Typography.Text strong>🖼️ 识图 AI（订单图片解析）</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 8px' }}>
          需支持视觉的模型 key（如阿里云百炼 qwen3-vl-flash）。识图接口地址留空时复用对话地址。
        </Typography.Paragraph>
        <div style={{ marginBottom: 16 }}>
          {fieldRow('visionApiKey', 'API Key', 'sk-…', true)}
          {fieldRow('visionBaseUrl', '接口地址', 'https://dashscope.aliyuncs.com/compatible-mode/v1')}
          {fieldRow('visionModel', '模型', 'qwen3-vl-flash')}
          <Button size="small" loading={testing === 'vision'} onClick={() => test('vision')} style={{ marginTop: 6 }}>测试识图连接</Button>
        </div>
        <Divider style={{ margin: '4px 0 12px' }} />
        <Space>
          <Button type="primary" loading={saving} onClick={save}>保存 AI 配置</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            保存后：AI 助手页 / 订单 AI 导入 立即切换为真实模型
          </Text>
        </Space>
      </Form>
    </Card>
  )
}
