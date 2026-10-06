import { Button, Card, Col, Divider, Flex, Form, Input, Popconfirm, Row, Select, Space, Switch, Tag, Tooltip, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import CrudResource from '../components/CrudResource'
import type { FieldConfig } from '../components/CrudResource'
import MasterImportCard from '../components/MasterImportCard'
import ProcessDictCard from '../components/ProcessDictCard'
import ProcessRouteCard from '../components/ProcessRouteCard'
import InvoiceSettingsCard from '../components/InvoiceSettingsCard'
import UpdateCard from '../components/UpdateCard'
import UserManageCard from '../components/UserManageCard'
import {
  CATALOG_ANCHOR_LABEL, CATALOG_ANCHOR_OPTIONS, CATALOG_GAS_LABEL, CATALOG_GAS_OPTIONS,
  CATALOG_SERIES_LABEL, CATALOG_SERIES_OPTIONS, CATALOG_SERIES_SHORT, PRODUCT_TYPE_LABEL, SETTLEMENT_LABEL,
} from '../lib/labels'
import { PLACEHOLDER_HINT, useShowPlaceholders, withPlaceholders } from '../lib/placeholders'
import { api } from '../lib/api'
import type { ColumnsType } from 'antd/es/table'

const { Text } = Typography

const PRODUCT_TYPE_OPTIONS = Object.entries(PRODUCT_TYPE_LABEL).map(([value, label]) => ({ value, label }))
const SETTLEMENT_OPTIONS = Object.entries(SETTLEMENT_LABEL).map(([value, label]) => ({ value, label }))

interface ProductPackagingRow { id?: number | null; packaging: string; note?: string | null; source?: string | null }
interface ProductRow {
  id: number
  name: string
  type: string
  defaultPackaging?: string | null
  defaultRouting?: string | null
  safetyStock: number
  /** 备注（产品名归一后从名字里归位的品牌/刻字/重量/货号/尺寸描述等） */
  remark?: string | null
  /** 归一前的原始产品名（无损留档） */
  legacyName?: string | null
  /** 默认包装多值（同一型号可以有多种） */
  packagings?: ProductPackagingRow[]
  updatedAt?: string
  // ---- 官方目录锚定列（2026 目录更正；迁移 0023 新增，未锚定时为 null）----
  /** 目录基础型号（1-101 / GPN / 6290NX…） */
  catalogModel?: string | null
  /** 目录 size（000 / 00 / 0 / 1…，前导零原样） */
  sizeSpec?: string | null
  /** 目录系列 / 款式（AMERICAN STYLE CUTTING TIP…） */
  series?: string | null
  /** 目录气体类型：LPG / ACETYLENE */
  gasType?: string | null
  /** 锚定状态：matched 已锚定 / unmatched 未锚定 */
  catalogAnchor?: string | null
  /** 锚定说明 / 未锚定原因 / 合并说明 */
  catalogNote?: string | null
}
interface CustomerRow { id: number; name: string; contact?: string | null; settlement?: string | null; creditDays: number; updatedAt?: string }
interface SupplierRow { id: number; name: string; contact?: string | null; settlement?: string | null; updatedAt?: string }
interface OperatorRow { id: number; name: string; boundPc?: string | null; note?: string | null; updatedAt?: string }

/** 更新时间格式化（列共用） */
const fmtDt = (v?: string) => (v ? v.slice(0, 16).replace('T', ' ') : '—')

/** 名称列：产品名常带换行（包装/刻字描述），单元格只显示第一行，悬停看全文 */
const firstLine = (v?: string | null) => String(v ?? '').split('\n')[0].trim()

/** 目录列统一「空 → —」展示 */
const dash = (v?: string | null) => (v ? v : '—')

/**
 * 产品目录列（本轮新增：型号 / size / 系列 / 气体类型 —— 目录锚定结果）；
 * 「类型」由目录推导（美式/英式 × 乙炔/丙烷；其余款式保持 tbd 不臆造），与「气体」列一起看即完整。
 */
/** 默认包装多值展示：一行一个 Tag；由既有文本列虚拟合成的标「旧」 */
const PackagingCell = ({ record }: { record: ProductRow }) => {
  const list = (record.packagings?.length
    ? record.packagings
    : record.defaultPackaging
      ? [{ packaging: record.defaultPackaging, source: 'legacy' }]
      : []) as ProductPackagingRow[]
  const texts = list.map((p) => p.packaging).filter(Boolean)
  if (!texts.length) return <span>—</span>
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{texts.join('\n')}</span>}>
      {/* 多值 Tag 用 flex-wrap：列宽不足时换行而不是把表格顶宽 */}
      <Flex wrap gap={4}>
        {texts.slice(0, 2).map((t, i) => (
          <Tag key={i} color={i === 0 ? 'blue' : 'default'} style={{ marginInlineEnd: 0, maxWidth: '100%' }}>
            {firstLine(t).slice(0, 14)}{firstLine(t).length > 14 ? '…' : ''}
          </Tag>
        ))}
        {texts.length > 2 && <Tag>+{texts.length - 2}</Tag>}
      </Flex>
    </Tooltip>
  )
}

const PRODUCT_COLUMNS: ColumnsType<ProductRow> = [
  {
    title: '产品名（size-型号）', dataIndex: 'name', width: 230, fixed: 'left', ellipsis: { showTitle: false },
    render: (v?: string | null) => <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>}>{firstLine(v)}</Tooltip>,
  },
  { title: '型号', dataIndex: 'catalogModel', width: 96, render: dash },
  { title: 'size', dataIndex: 'sizeSpec', width: 66, render: dash },
  {
    title: '系列', dataIndex: 'series', width: 90,
    render: (v?: string | null) => (v ? <Tooltip title={CATALOG_SERIES_LABEL[v] ?? v}>{CATALOG_SERIES_SHORT[v] ?? v}</Tooltip> : '—'),
  },
  { title: '气体', dataIndex: 'gasType', width: 108, render: (v?: string | null) => (v ? CATALOG_GAS_LABEL[v] ?? v : '—') },
  { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => PRODUCT_TYPE_LABEL[v] ?? v },
  {
    title: '锚定', dataIndex: 'catalogAnchor', width: 84,
    render: (v?: string | null) => (v === 'matched'
      ? <Tag color="green">{CATALOG_ANCHOR_LABEL.matched}</Tag>
      : v === 'unmatched' ? <Tag>{CATALOG_ANCHOR_LABEL.unmatched}</Tag> : '—'),
  },
  {
    title: '默认包装（可多值）', dataIndex: 'defaultPackaging', width: 190,
    render: (_: unknown, record: ProductRow) => <PackagingCell record={record} />,
  },
  {
    title: '备注', dataIndex: 'remark', width: 220, ellipsis: { showTitle: false },
    render: (v?: string | null) => (
      <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>}>{v ? firstLine(v) : '—'}</Tooltip>
    ),
  },
  {
    title: '默认工序路线', dataIndex: 'defaultRouting', width: 150, ellipsis: { showTitle: false },
    render: (v?: string | null) => <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>}>{v || '—'}</Tooltip>,
  },
  { title: '安全库存', dataIndex: 'safetyStock', width: 84, align: 'right' },
  { title: '更新时间', dataIndex: 'updatedAt', width: 130, render: (v?: string) => <Text type="secondary" style={{ fontSize: 12 }}>{fmtDt(v)}</Text> },
]

const CUSTOMER_COLUMNS: ColumnsType<CustomerRow> = [
  { title: '客户', dataIndex: 'name' },
  { title: '联系人', dataIndex: 'contact', render: (v?: string | null) => v || '—' },
  { title: '结算方式', dataIndex: 'settlement', width: 190, render: (v?: string | null) => (v ? SETTLEMENT_LABEL[v] ?? v : '—') },
  { title: '账期（天）', dataIndex: 'creditDays', width: 100, align: 'right' },
  { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => <Text type="secondary" style={{ fontSize: 12 }}>{fmtDt(v)}</Text> },
]

const SUPPLIER_COLUMNS: ColumnsType<SupplierRow> = [
  { title: '供应商', dataIndex: 'name' },
  { title: '联系人', dataIndex: 'contact', render: (v?: string | null) => v || '—' },
  { title: '结算方式', dataIndex: 'settlement', width: 190, render: (v?: string | null) => (v ? SETTLEMENT_LABEL[v] ?? v : '—') },
  { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => <Text type="secondary" style={{ fontSize: 12 }}>{fmtDt(v)}</Text> },
]

const OPERATOR_COLUMNS: ColumnsType<OperatorRow> = [
  { title: '操作人', dataIndex: 'name' },
  { title: '绑定 PC', dataIndex: 'boundPc', width: 170, render: (v?: string | null) => v || '不绑定（机动）' },
  { title: '备注', dataIndex: 'note', render: (v?: string | null) => v || '—' },
  { title: '更新时间', dataIndex: 'updatedAt', width: 140, render: (v?: string) => <Text type="secondary" style={{ fontSize: 12 }}>{fmtDt(v)}</Text> },
]

// =====================================================================================
// 产品目录筛选（本轮新增：系列 / 气体类型 / 锚定状态 + 关键词）
// -------------------------------------------------------------------------------------
// 口径：
//   · 与既有关键词搜索**并存**（AND 关系），筛选与搜索都下推到后端（GET /products?…）；
//   · 状态**保留在地址栏**（?series=…&gas=…&anchor=…&kw=…），刷新/分享链接后筛选不丢；
//     本应用是极简 pathname 路由（lib/router.ts），只用 replaceState 改 query，不影响路由。
// =====================================================================================
const CATALOG_FILTER_KEYS = ['series', 'gas', 'anchor', 'kw'] as const
type CatalogFilterState = { series: string; gas: string; anchor: string; kw: string }

/** 从地址栏读回筛选状态（首次渲染用） */
function readCatalogFilters(): CatalogFilterState {
  try {
    const p = new URLSearchParams(window.location.search)
    return { series: p.get('series') ?? '', gas: p.get('gas') ?? '', anchor: p.get('anchor') ?? '', kw: p.get('kw') ?? '' }
  } catch {
    return { series: '', gas: '', anchor: '', kw: '' }
  }
}

/** 把筛选状态写回地址栏（replaceState：不新增历史记录、不影响 pathname 路由） */
function writeCatalogFilters(v: CatalogFilterState): void {
  try {
    const p = new URLSearchParams(window.location.search)
    for (const k of CATALOG_FILTER_KEYS) {
      const val = v[k]
      if (val) p.set(k, val)
      else p.delete(k)
    }
    const qs = p.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''))
  } catch {
    /* 隐私模式等不可写时忽略（仅本次会话生效） */
  }
}

/**
 * 产品目录卡片：默认**按系列分组排序**（同一系列排一起，组内按 型号 → size；无系列排最后），
 * 并提供 系列 / 气体类型 / 锚定状态 三个筛选 + 关键词搜索（与既有搜索并存）。
 */
function ProductCatalogCard({ showPlaceholders, onChanged }: { showPlaceholders: boolean; onChanged: () => void }) {
  const init = useMemo(readCatalogFilters, [])
  const [series, setSeries] = useState(init.series)
  const [gas, setGas] = useState(init.gas)
  const [anchor, setAnchor] = useState(init.anchor)
  const [kwInput, setKwInput] = useState(init.kw)   // 输入框里的文字
  const [kw, setKw] = useState(init.kw)             // 已提交的关键词（回车/点搜索才生效）

  useEffect(() => { writeCatalogFilters({ series, gas, anchor, kw }) }, [series, gas, anchor, kw])

  const listQuery = useMemo(() => {
    const p = new URLSearchParams()
    if (series) p.set('series', series)
    if (gas) p.set('gasType', gas)
    if (anchor) p.set('anchor', anchor)
    if (kw.trim()) p.set('kw', kw.trim())
    const qs = p.toString()
    return withPlaceholders(qs ? '?' + qs : '', showPlaceholders)
  }, [series, gas, anchor, kw, showPlaceholders])

  const reset = () => { setSeries(''); setGas(''); setAnchor(''); setKwInput(''); setKw('') }

  const toolbar = (
    // Flex wrap：筛选控件与说明文字在窄屏自动换行，说明文字允许收缩（minWidth: 0）
    <Flex wrap gap={8} align="center">
      <Select size="small" style={{ width: 168 }} allowClear placeholder="全部系列（包含匹配）"
        value={series || undefined} onChange={(v?: string) => setSeries(v ?? '')} options={CATALOG_SERIES_OPTIONS} />
      <Select size="small" style={{ width: 140 }} allowClear placeholder="全部气体类型"
        value={gas || undefined} onChange={(v?: string) => setGas(v ?? '')} options={CATALOG_GAS_OPTIONS} />
      <Select size="small" style={{ width: 124 }} allowClear placeholder="全部锚定状态"
        value={anchor || undefined} onChange={(v?: string) => setAnchor(v ?? '')} options={CATALOG_ANCHOR_OPTIONS} />
      <Input.Search size="small" style={{ width: 230 }} allowClear placeholder="产品名 / 型号 / size / 系列"
        value={kwInput} onChange={(e) => setKwInput(e.target.value)}
        onSearch={(v) => setKw(v)} />
      <Button size="small" onClick={reset}>重置筛选</Button>
      <Text type="secondary" style={{ fontSize: 12, flex: '1 1 240px', minWidth: 0 }}>
        按系列分组排序（官方目录顺序）· 系列为**包含匹配**（AMERICAN 命中 AMERICAN STYLE CUTTING TIP）· 筛选状态保留在地址栏
      </Text>
    </Flex>
  )

  return (
    <CrudResource<ProductRow>
      title="产品目录"
      resource="products"
      columns={PRODUCT_COLUMNS}
      fields={PRODUCT_FIELDS}
      initialValues={{ safetyStock: 0 }}
      onChanged={onChanged}
      listQuery={listQuery}
      toolbar={toolbar}
    />
  )
}

const PRODUCT_FIELDS: FieldConfig[] = [
  {
    name: 'name', label: '产品名（{size}-{型号}）', required: true,
    placeholder: '如：0-1-101 / 000-3-101 / 0-261（size 用目录原值，不补零不删零）',
  },
  { name: 'type', label: '类型', required: true, kind: 'select', options: PRODUCT_TYPE_OPTIONS },
  {
    name: 'packagings', label: '默认包装（可多种）', kind: 'packagings',
    placeholder: '如：塑壳 红盖 不干胶 50只/中盒',
  },
  { name: 'remark', label: '备注', placeholder: '如：品牌 VICTOR / 刻字 / 重量 93g / 货号 4154 / 尺寸描述' },
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

/** 界面顶端展示四实体数量汇总（reloadToken 变化时重新拉取，保证增删改后同步） */
function EntityStats({ reloadToken = 0 }: { reloadToken?: number }) {
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
  }, [reloadToken])
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
  // 主数据/字典任一增删改后自增，驱动实体统计与产品工序路线等联动刷新
  const [dataVersion, setDataVersion] = useState(0)
  const bumpData = () => setDataVersion((v) => v + 1)
  // I17 裁定②：「显示占位档案」开关（默认关闭 = 客户/产品列表隐藏两个占位档案）
  const [showPlaceholders, setShowPlaceholders] = useShowPlaceholders()
  return (
    <div style={{ maxWidth: 1240 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>主数据（设置）</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        订单/计划单/排期/仓储/账目的唯一引用来源。直接生效无草稿态。
      </Typography.Paragraph>
      <EntityStats reloadToken={dataVersion} />
      {/* I17 裁定②：占位档案（未建档客户·待补 / 未建档产品·待补）默认隐藏，此开关仅供排查 */}
      <Space size={8} style={{ marginTop: 8 }}>
        <Tooltip title={PLACEHOLDER_HINT}>
          <Switch size="small" checked={showPlaceholders} onChange={setShowPlaceholders} />
        </Tooltip>
        <Tooltip title={PLACEHOLDER_HINT}>
          <Typography.Text type="secondary" style={{ cursor: 'help' }}>
            显示占位档案（未建档客户·待补 / 未建档产品·待补；默认隐藏）
          </Typography.Text>
        </Tooltip>
      </Space>
      {/*
        纵向 Flex 而不是 CSS Grid：Grid 子项默认 min-width:auto，其自动最小尺寸取 min-content，
        产品目录表 12 列（本页最宽卡片）的 min-content ≈1.7k px，会把整页在 1280 档撑到 2044px（实测）。
        纵向 Flex 的自动最小尺寸只作用于主轴（纵向），横向由容器宽度决定，
        表格因此收敛为「卡片内部横向滚动」（见 CrudResource 的 scroll.x = max-content）。
      */}
      <Flex vertical gap={16} style={{ marginTop: 12, minWidth: 0 }}>
        <ProductCatalogCard showPlaceholders={showPlaceholders} onChanged={bumpData} />
        <MasterImportCard target="products" title="产品目录 · 批量导入（Excel / CSV）" onChanged={bumpData} />
        <CrudResource<CustomerRow>
          title="客户档案"
          resource="customers"
          columns={CUSTOMER_COLUMNS}
          fields={CUSTOMER_FIELDS}
          initialValues={{ creditDays: 30 }}
          onChanged={bumpData}
          listQuery={withPlaceholders('', showPlaceholders)}
        />
        <MasterImportCard target="customers" title="客户档案 · 批量导入（Excel / CSV）" onChanged={bumpData} />
        <CrudResource<SupplierRow>
          title="供应商档案"
          resource="suppliers"
          columns={SUPPLIER_COLUMNS}
          fields={SUPPLIER_FIELDS}
          onChanged={bumpData}
        />
        <CrudResource<OperatorRow>
          title="操作人（固定名单 / PC 绑定）"
          resource="operators"
          columns={OPERATOR_COLUMNS}
          fields={OPERATOR_FIELDS}
          onChanged={bumpData}
        />
        <UserManageCard />
        <ProcessDictCard onChanged={bumpData} />
        <ProcessRouteCard reloadToken={dataVersion} />
        {/* 开票默认税率（I16 收敛②）：复用 app_settings 的极简单行配置 */}
        <InvoiceSettingsCard />
        <AiConfigCard />
        <UpdateCard />
      </Flex>
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
      // 注意：api() 内部会对 body 做 JSON.stringify，此处必须传对象（传字符串会被二次序列化 → 400）
      await api('/ai/config', { method: 'POST', body: patch })
      message.success('已保存并立即生效（无需重启）')
      setInput({})
      await load()
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const clearField = async (f: string) => {
    try {
      await api('/ai/config', { method: 'POST', body: { [f]: '' } })
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
      const r = await api<{ ok: boolean; message: string }>('/ai/test', { method: 'POST', body: { kind } })
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
      // 不再写死 380px：占满栅格列并设上限，窄屏可收缩
      style: { width: '100%', maxWidth: 380, minWidth: 0 },
      disabled: loading,
      ...(isKey ? { type: 'password' as const, autoComplete: 'new-password' } : {}),
    }
  }

  const fieldRow = (f: string, label: string, ph: string, isKey = false) => {
    const st = s(f)
    const configured = isKey ? !!st?.keySet : !!st?.value
    return (
      // 响应式栅格：xs 标签与输入框上下排列，sm 及以上左右排列（原实现是固定 110px 标签 + 380px 输入框，窄屏不折行）
      <Row key={f} gutter={[8, 4]} align="middle" style={{ marginBottom: 4 }}>
        <Col xs={24} sm={6} md={4}>
          <div style={{ fontSize: 13, color: '#666' }}>{label}</div>
        </Col>
        <Col xs={24} sm={18} md={20}>
          <Flex gap={8} align="center" wrap>
            <Input {...inputProps(f, ph, isKey)} />
            {isKey && configured && (
              <Popconfirm title="清除后回退默认（.env）配置？" onConfirm={() => clearField(f)} okText="清除" okButtonProps={{ danger: true }}>
                <Button size="small" type="link" danger>清除</Button>
              </Popconfirm>
            )}
          </Flex>
        </Col>
      </Row>
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
        <Space wrap>
          <Button type="primary" loading={saving} onClick={save}>保存 AI 配置</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            保存后：AI 助手页 / 订单 AI 导入 立即切换为真实模型
          </Text>
        </Space>
      </Form>
    </Card>
  )
}
