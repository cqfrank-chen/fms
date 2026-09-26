import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Descriptions, Empty, Input, InputNumber, Modal, Popconfirm, Radio,
  Row, Select, Space, Statistic, Table, Tabs, Tag, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { COST_CATEGORY_LABEL, COST_CATEGORY_ORDER, SLIP_MODE_LABEL } from '../lib/labels'
import type {
  CollectionSlip, Customer, MonthlyCost, Payable, PaymentSlip, ProfitView, Receivable,
  SlipMode, StatementRow, Supplier,
} from '../lib/types'

const { Text } = Typography
const fmt = (n: number | undefined | null) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
/** 按 value 去重的下拉选项 */
const uniqOpts = (arr: Array<{ value: number | string; label: string }>) =>
  [...new Map(arr.map((o) => [String(o.value), o])).values()]

/** 账目页（I09）：应收/应付/收款/付款/对账/利润/月度成本 + 四表导出 */
function AccountingPage() {
  return (
    <Card size="small" styles={{ body: { paddingTop: 4 } }}>
      <Tabs size="small" defaultActiveKey="receivable" items={[
        { key: 'receivable', label: '应收记录', children: <ReceivableTab /> },
        { key: 'collect', label: '收款单', children: <CollectTab /> },
        { key: 'payable', label: '应付记录', children: <PayableTab /> },
        { key: 'pay', label: '付款单', children: <PayTab /> },
        { key: 'statement', label: '对账单', children: <StatementTab /> },
        { key: 'profit', label: '利润视图', children: <ProfitTab /> },
        { key: 'cost', label: '月度成本', children: <CostTab /> },
      ]} />
    </Card>
  )
}

/** 通用核销/预收预付弹窗（direction=collect 面向客户应收；pay 面向供应商应付） */
function SlipModal({ open, direction, onClose }: { open: boolean; direction: 'collect' | 'pay'; onClose: (reload: boolean) => void }) {
  const isCollect = direction === 'collect'
  const [partyId, setPartyId] = useState<number>()
  const [mode, setMode] = useState<SlipMode>('settle')
  const [parties, setParties] = useState<(Customer | Supplier)[]>([])
  const [openDebts, setOpenDebts] = useState<Receivable[] | Payable[]>([])
  const [sel, setSel] = useState<Record<number, number>>({})
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  /** 预收冲抵模式下的可用预收余额（仅客户方向；服务端仍会强校验） */
  const [availPrepay, setAvailPrepay] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    api<(Customer | Supplier)[]>(isCollect ? '/customers' : '/suppliers').then(setParties).catch(() => {})
    setPartyId(undefined); setMode('settle'); setOpenDebts([]); setSel({}); setNote('')
  }, [open, isCollect])

  useEffect(() => {
    if (!open || mode !== 'apply' || !partyId || !isCollect) { setAvailPrepay(null); return }
    api<any[]>('/statements')
      .then((rows) => setAvailPrepay(rows.find((r) => r.customerId === partyId)?.prepay ?? 0))
      .catch(() => setAvailPrepay(null))
  }, [open, mode, partyId, isCollect])

  async function pickParty(id: number) {
    setPartyId(id)
    const url = isCollect ? `/receivables?customerId=${id}` : `/payables?supplierId=${id}`
    // 服务端不支持该筛选，本地过滤
    const all = await api<Receivable[] | Payable[]>(isCollect ? '/receivables' : '/payables')
    const list = (all as any[]).filter((r: any) => (isCollect ? r.customerId : r.supplierId) === id && r.status !== 'voided' && r.remain > 0)
    setOpenDebts(list)
    const init: Record<number, number> = {}
    for (const r of list) init[r.id] = r.remain
    setSel(init)
    void url
  }

  const total = Object.values(sel).reduce((s, v) => s + (v || 0), 0)
  const totalRemain = (openDebts as any[]).reduce((s, r: any) => s + r.remain, 0)

  async function submit() {
    if (!partyId) { message.warning('请选择客户'); return }
    const amount = mode === 'prepay' ? (sel[0] ?? 0) : total
    if (amount <= 0) { message.warning(mode === 'prepay' ? '请填写预收/预付金额' : '请至少核销一笔金额 > 0'); return }
    setSaving(true)
    try {
      const body = {
        partyId,
        mode,
        amount,
        note: note || undefined,
        lines: mode === 'prepay' ? undefined : (openDebts as any[]).filter((r) => (sel[r.id] ?? 0) > 0).map((r) => ({ id: r.id, amount: sel[r.id] })),
      }
      await api(isCollect ? '/collection-slips' : '/payment-slips', { method: 'POST', body })
      message.success(isCollect ? '收款单已生效（核销=营收确认）' : '付款单已生效')
      onClose(true)
    } catch (e) {
      message.error((e as Error).message)
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title={isCollect ? '新建收款单' : '新建付款单'}
      open={open} onCancel={() => onClose(false)} onOk={submit} confirmLoading={saving}
      okText={isCollect ? '收款（一步生效）' : '付款（一步生效）'} width={700}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>{isCollect ? '客户' : '供应商'}</Text>
          <Select style={{ width: '100%' }} value={partyId} onChange={pickParty} placeholder={isCollect ? '选择客户' : '选择供应商'} showSearch optionFilterProp="label"
            options={(parties as any[]).map((p) => ({ value: p.id, label: p.name }))} />
        </div>
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>模式</Text>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
            <Radio.Button value="settle">{isCollect ? '核销（冲抵应收）' : '核销（冲抵应付）'}</Radio.Button>
            <Radio.Button value="prepay">{isCollect ? '预收（30%定金等）' : '预付（供应商定金）'}</Radio.Button>
            <Radio.Button value="apply">{isCollect ? '预收冲抵（用定金核销）' : '预付冲抵（用定金核销）'}</Radio.Button>
          </Radio.Group>
        </div>
        {mode !== 'prepay' ? (
          partyId && (
            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
                核销明细（默认全额；可改小=部分核销。合计 {fmt(total)}，未结 {fmt(totalRemain)}
                {mode === 'apply' && availPrepay != null ? `；可用预收 ¥${fmt(availPrepay)}` : ''}）
              </Text>
              {openDebts.length === 0
                ? <Alert type="info" showIcon message="该往来户暂无未结清款项（可改用预收/预付登记）" />
                : openDebts.map((r: any) => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Text style={{ width: 210, fontSize: 13 }} ellipsis>{r.recvNo ?? r.payNo} · {fmt(r.remain)}</Text>
                    <Text type="secondary" style={{ fontSize: 12, width: 90 }}>{r.overDue ? '⚠逾期' : r.dueDate ? `到期 ${(r.dueDate || '').slice(0, 10)}` : ''}</Text>
                    <InputNumber style={{ width: 140 }} min={0} max={r.remain} value={sel[r.id] ?? 0}
                      onChange={(v) => setSel((p) => ({ ...p, [r.id]: (v as number) ?? 0 }))} />
                  </div>
                ))}
            </div>
          )
        ) : (
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>{isCollect ? '预收金额（元）' : '预付金额（元）'}</Text>
            <InputNumber style={{ width: '100%' }} min={0.01} value={sel[0] ?? 0}
              onChange={(v) => setSel({ 0: (v as number) ?? 0 })} />
          </div>
        )}
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>备注</Text>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {mode === 'settle'
            ? isCollect ? '收款核销即确认营收（现金收付制）；一步生效，错误用冲销纠正' : '付款核销即冲抵应付；一步生效，错误用冲销纠正'
            : mode === 'apply'
              ? isCollect ? '预收冲抵：用已收定金核销应收（计营收），不产生现金流入；余额不足会被拒绝' : '预付冲抵：用已付定金核销应付，不产生现金流出；余额不足会被拒绝'
              : '预收/预付挂往来余额（不计营收），后续用「冲抵」核销具体单据'}
        </Text>
      </Space>
    </Modal>
  )
}

/** 应收记录 + 账龄（默认最新在前） */
function ReceivableTab() {
  const [rows, setRows] = useState<Receivable[]>([])
  const [loading, setLoading] = useState(false)
  const [custId, setCustId] = useState<number>()
  const [st, setSt] = useState<string>()
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<Receivable[]>('/receivables')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const custOpts = useMemo(
    () => uniqOpts(rows.map((r) => ({ value: r.customerId, label: r.customerName || `#${r.customerId}` }))),
    [rows],
  )
  const filtered = useMemo(() => rows.filter((r) => {
    if (custId !== undefined && r.customerId !== custId) return false
    if (st === 'open') return r.status !== 'voided' && r.remain > 0
    if (st === 'overdue') return r.status !== 'voided' && r.remain > 0 && r.overDue
    if (st === 'settled') return r.status !== 'voided' && r.remain <= 0
    if (st === 'voided') return r.status === 'voided'
    return true
  }), [rows, custId, st])

  const bucketTag = (r: Receivable) => {
    if (r.status === 'voided') return <Tag color="error">已冲销</Tag>
    if (r.settled || r.remain <= 0) return <Tag color="success">已结清</Tag>
    if (r.overDue) return <Tag color="error">逾期 {r.ageDays} 天</Tag>
    return <Tag>未到期</Tag>
  }

  const columns: ColumnsType<Receivable> = [
    { title: '关联订单', dataIndex: 'orderNo', width: 170, render: (v?: string) => (v ? <Text strong style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">—</Text>) },
    { title: '应收号', dataIndex: 'recvNo', width: 150, render: (v: string) => <Text strong>{v}</Text> },
    { title: '客户', dataIndex: 'customerName', width: 140 },
    { title: '金额', width: 105, render: (_, r) => (r.status === 'voided' ? <Text type="secondary" delete>{fmt(r.amount)}</Text> : `${fmt(r.amount)} ${r.currency}`) },
    { title: '已核销', dataIndex: 'settledAmount', width: 95, render: (v: number) => fmt(v) },
    { title: '未结', width: 95, render: (_, r) => (r.status === 'voided' ? <Tag color="error">已冲销</Tag> : <Text strong style={{ color: r.remain > 0 && r.overDue ? '#cf1322' : undefined }}>{fmt(r.remain)}</Text>) },
    { title: '到期日', dataIndex: 'dueDate', width: 105, render: (v?: string | null) => (v ? v.slice(0, 10) : '—') },
    { title: '账龄', width: 115, render: (_, r) => bucketTag(r) },
    { title: '更新时间', dataIndex: 'updatedAt', width: 130, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—') },
  ]
  return (
    <div>
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Select size="small" style={{ width: 170 }} allowClear showSearch optionFilterProp="label"
          placeholder="按客户筛选" value={custId} onChange={(v) => setCustId(v as number)} options={custOpts} />
        <Select size="small" style={{ width: 130 }} allowClear placeholder="按状态筛选"
          value={st} onChange={setSt}
          options={[
            { value: 'open', label: '未结清' },
            { value: 'overdue', label: '逾期' },
            { value: 'settled', label: '已结清' },
            { value: 'voided', label: '已冲销' },
          ]} />
        {(custId !== undefined || st !== undefined) && (
          <Button size="small" onClick={() => { setCustId(undefined); setSt(undefined) }}>清空筛选</Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>{filtered.length} / {rows.length} 条</Text>
      </Space>
      <Table<Receivable> rowKey="id" size="small" loading={loading} columns={columns} dataSource={filtered}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description={rows.length && !filtered.length ? '无符合筛选条件的记录' : '暂无应收 —— 订单确认时自动生成，出货不重复开立'} /> }} />
    </div>
  )
}

/** 应付记录（默认最新在前） */
function PayableTab() {
  const [rows, setRows] = useState<Payable[]>([])
  const [loading, setLoading] = useState(false)
  const [supId, setSupId] = useState<number>()
  const [st, setSt] = useState<string>()
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<Payable[]>('/payables')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const supOpts = useMemo(
    () => uniqOpts(rows.map((r) => ({ value: r.supplierId, label: r.supplierName || `#${r.supplierId}` }))),
    [rows],
  )
  const filtered = useMemo(() => rows.filter((r) => {
    if (supId !== undefined && r.supplierId !== supId) return false
    if (st === 'open') return r.status !== 'voided' && r.remain > 0
    if (st === 'settled') return r.status !== 'voided' && r.remain <= 0
    if (st === 'voided') return r.status === 'voided'
    return true
  }), [rows, supId, st])

  const columns: ColumnsType<Payable> = [
    { title: '应付号', dataIndex: 'payNo', width: 160, render: (v: string) => <Text strong>{v}</Text> },
    { title: '供应商', dataIndex: 'supplierName', width: 150 },
    { title: '来源来料', dataIndex: 'incomingNo', width: 160, render: (v?: string) => v || '—' },
    { title: '金额', dataIndex: 'amount', width: 110, render: (v: number) => fmt(v) },
    { title: '已核销', dataIndex: 'settledAmount', width: 100, render: (v: number) => fmt(v) },
    { title: '未结', dataIndex: 'remain', width: 100, render: (v: number) => <Text strong>{fmt(v)}</Text> },
    { title: '状态', width: 100, render: (_, r) => (r.settled ? <Tag color="success">已结清</Tag> : r.status === 'voided' ? <Tag color="error">已冲销</Tag> : <Tag>未结</Tag>) },
    { title: '更新时间', dataIndex: 'updatedAt', width: 130, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—') },
  ]
  return (
    <div>
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Select size="small" style={{ width: 170 }} allowClear showSearch optionFilterProp="label"
          placeholder="按供应商筛选" value={supId} onChange={(v) => setSupId(v as number)} options={supOpts} />
        <Select size="small" style={{ width: 130 }} allowClear placeholder="按状态筛选"
          value={st} onChange={setSt}
          options={[
            { value: 'open', label: '未结' },
            { value: 'settled', label: '已结清' },
            { value: 'voided', label: '已冲销' },
          ]} />
        {(supId !== undefined || st !== undefined) && (
          <Button size="small" onClick={() => { setSupId(undefined); setSt(undefined) }}>清空筛选</Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>{filtered.length} / {rows.length} 条</Text>
      </Space>
      <Table<Payable> rowKey="id" size="small" loading={loading} columns={columns} dataSource={filtered}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description={rows.length && !filtered.length ? '无符合筛选条件的记录' : '暂无应付 —— 来料登记自动生成'} /> }} />
    </div>
  )
}

/** 收款单列表 + 新建 */
function CollectTab() {
  const [rows, setRows] = useState<CollectionSlip[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [acting, setActing] = useState<number | null>(null)
  const [custId, setCustId] = useState<number>()
  const [mode, setMode] = useState<string>()
  const [st, setSt] = useState<string>()
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<CollectionSlip[]>('/collection-slips')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  async function voidSlip(id: number) {
    setActing(id)
    try { await api(`/collection-slips/${id}/void`, { method: 'POST' }); message.success('已冲销（核销回滚）'); load() }
    catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  const custOpts = useMemo(
    () => uniqOpts(rows.map((r) => ({ value: r.customerId, label: r.customerName || `#${r.customerId}` }))),
    [rows],
  )
  const filtered = useMemo(() => rows.filter((r) => {
    if (custId !== undefined && r.customerId !== custId) return false
    if (mode && r.mode !== mode) return false
    if (st && r.status !== st) return false
    return true
  }), [rows, custId, mode, st])
  const hasFilter = custId !== undefined || mode !== undefined || st !== undefined

  const columns: ColumnsType<CollectionSlip> = [
    {
      title: '关联订单', width: 200,
      render: (_, r) => {
        const nos = [...new Set((r.lines ?? []).map((l) => l.orderNo).filter(Boolean))] as string[]
        return nos.length
          ? <Text strong style={{ fontSize: 12 }}>{nos.join('、')}</Text>
          : <Text type="secondary" style={{ fontSize: 12 }}>{r.mode === 'prepay' ? '（预收）' : '—'}</Text>
      },
    },
    { title: '收款单号', dataIndex: 'collectNo', width: 150, render: (v: string) => <Text strong>{v}</Text> },
    { title: '日期', dataIndex: 'createdAt', width: 105, render: (v: string) => v.slice(0, 10) },
    { title: '客户', dataIndex: 'customerName', width: 130 },
    { title: '模式', dataIndex: 'mode', width: 90, render: (v: string) => <Tag color={v === 'settle' ? 'blue' : 'purple'}>{SLIP_MODE_LABEL[v]}</Tag> },
    { title: '金额', dataIndex: 'amount', width: 105, render: (v: number) => fmt(v) },
    { title: '核销对象', width: 170, render: (_, r) => (r.lines?.length ? r.lines.map((l) => l.recvNo ?? '').filter(Boolean).join('、') : r.mode === 'prepay' ? '（挂客户预收余额）' : '—') },
    { title: '状态', dataIndex: 'status', width: 85, render: (v: string) => <Tag color={v === 'confirmed' ? 'success' : 'error'}>{v === 'confirmed' ? '生效' : '已冲销'}</Tag> },
    { title: '操作', width: 85, render: (_, r) => (r.status === 'confirmed'
      ? <Popconfirm title="冲销将回滚核销，确认？" onConfirm={() => voidSlip(r.id)}><Button size="small" danger loading={acting === r.id}>冲销</Button></Popconfirm>
      : <Text type="secondary" style={{ fontSize: 12 }}>已冲销</Text>) },
  ]
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setOpen(true)}>+ 新建收款单</Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>核销应收=确认营收（现金收付制）；预收模式覆盖 OEM 30% 定金</Text>
      </div>
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Select size="small" style={{ width: 170 }} allowClear showSearch optionFilterProp="label"
          placeholder="按客户筛选" value={custId} onChange={(v) => setCustId(v as number)} options={custOpts} />
        <Select size="small" style={{ width: 130 }} allowClear placeholder="按模式筛选"
          value={mode} onChange={setMode}
          options={Object.entries(SLIP_MODE_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select size="small" style={{ width: 130 }} allowClear placeholder="按状态筛选"
          value={st} onChange={setSt}
          options={[
            { value: 'confirmed', label: '生效' },
            { value: 'voided', label: '已冲销' },
          ]} />
        {hasFilter && (
          <Button size="small" onClick={() => { setCustId(undefined); setMode(undefined); setSt(undefined) }}>清空筛选</Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>{filtered.length} / {rows.length} 条</Text>
      </Space>
      <Table<CollectionSlip> rowKey="id" size="small" loading={loading} columns={columns} dataSource={filtered}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description={rows.length && !filtered.length ? '无符合筛选条件的记录' : '暂无收款单 —— 点击上方「新建收款单」登记'} /> }} />
      <SlipModal open={open} direction="collect" onClose={(reload) => { setOpen(false); if (reload) load() }} />
    </div>
  )
}

/** 付款单列表 + 新建 */
function PayTab() {
  const [rows, setRows] = useState<PaymentSlip[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [acting, setActing] = useState<number | null>(null)
  const [supId, setSupId] = useState<number>()
  const [mode, setMode] = useState<string>()
  const [st, setSt] = useState<string>()
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<PaymentSlip[]>('/payment-slips')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  async function voidSlip(id: number) {
    setActing(id)
    try { await api(`/payment-slips/${id}/void`, { method: 'POST' }); message.success('已冲销（核销回滚）'); load() }
    catch (e) { message.error((e as Error).message) }
    finally { setActing(null) }
  }

  const supOpts = useMemo(
    () => uniqOpts(rows.map((r) => ({ value: r.supplierId, label: r.supplierName || `#${r.supplierId}` }))),
    [rows],
  )
  const filtered = useMemo(() => rows.filter((r) => {
    if (supId !== undefined && r.supplierId !== supId) return false
    if (mode && r.mode !== mode) return false
    if (st && r.status !== st) return false
    return true
  }), [rows, supId, mode, st])
  const hasFilter = supId !== undefined || mode !== undefined || st !== undefined

  const columns: ColumnsType<PaymentSlip> = [
    { title: '付款单号', dataIndex: 'payNo', width: 160, render: (v: string) => <Text strong>{v}</Text> },
    { title: '日期', dataIndex: 'createdAt', width: 110, render: (v: string) => v.slice(0, 10) },
    { title: '供应商', dataIndex: 'supplierName', width: 150 },
    { title: '模式', dataIndex: 'mode', width: 100, render: (v: string) => <Tag color={v === 'settle' ? 'blue' : 'purple'}>{SLIP_MODE_LABEL[v]}</Tag> },
    { title: '金额', dataIndex: 'amount', width: 110, render: (v: number) => fmt(v) },
    { title: '核销对象', width: 200, render: (_, r) => (r.lines?.length ? r.lines.map((l) => l.payNo ?? '').filter(Boolean).join('、') : r.mode === 'prepay' ? '（挂供应商预付余额）' : '—') },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'confirmed' ? 'success' : 'error'}>{v === 'confirmed' ? '生效' : '已冲销'}</Tag> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 130, render: (v?: string) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(0, 16).replace('T', ' ')}</Text> : '—') },
    { title: '操作', width: 90, render: (_, r) => (r.status === 'confirmed'
      ? <Popconfirm title="冲销将回滚核销，确认？" onConfirm={() => voidSlip(r.id)}><Button size="small" danger loading={acting === r.id}>冲销</Button></Popconfirm>
      : <Text type="secondary" style={{ fontSize: 12 }}>已冲销</Text>) },
  ]
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setOpen(true)}>+ 新建付款单</Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>核销应付；预付模式覆盖供应商定金（与收款单同构）</Text>
      </div>
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Select size="small" style={{ width: 170 }} allowClear showSearch optionFilterProp="label"
          placeholder="按供应商筛选" value={supId} onChange={(v) => setSupId(v as number)} options={supOpts} />
        <Select size="small" style={{ width: 130 }} allowClear placeholder="按模式筛选"
          value={mode} onChange={setMode}
          options={Object.entries(SLIP_MODE_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select size="small" style={{ width: 130 }} allowClear placeholder="按状态筛选"
          value={st} onChange={setSt}
          options={[
            { value: 'confirmed', label: '生效' },
            { value: 'voided', label: '已冲销' },
          ]} />
        {hasFilter && (
          <Button size="small" onClick={() => { setSupId(undefined); setMode(undefined); setSt(undefined) }}>清空筛选</Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>{filtered.length} / {rows.length} 条</Text>
      </Space>
      <Table<PaymentSlip> rowKey="id" size="small" loading={loading} columns={columns} dataSource={filtered}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description={rows.length && !filtered.length ? '无符合筛选条件的记录' : '暂无付款单 —— 点击上方「新建付款单」登记'} /> }} />
      <SlipModal open={open} direction="pay" onClose={(reload) => { setOpen(false); if (reload) load() }} />
    </div>
  )
}

/** 对账单：按客户 + 账龄分桶 */
function StatementTab() {
  const [rows, setRows] = useState<StatementRow[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<StatementRow[]>('/statements')) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  const columns: ColumnsType<StatementRow> = [
    { title: '客户', dataIndex: 'customerName', width: 180, render: (v: string) => <Text strong>{v}</Text> },
    { title: '期初', width: 100, render: () => <Text type="secondary">0.00</Text> },
    { title: '本期出库(应收)', dataIndex: 'invoiced', width: 130, render: (v: number) => fmt(v) },
    { title: '本期收款(核销)', dataIndex: 'settled', width: 140, render: (v: number) => fmt(v) },
    { title: '预收(贷方)', dataIndex: 'prepay', width: 110, render: (v: number) => (v ? <Text type="warning">-{fmt(v)}</Text> : '—') },
    { title: '期末余额', dataIndex: 'balance', width: 120, render: (v: number, r) => <Text strong style={{ color: r.balance > 0 && r.overDueTotal > 0 ? '#cf1322' : undefined }}>{fmt(v)}</Text> },
    {
      title: '账龄分桶（未结）', render: (_, r) => {
        const b = r.buckets
        const parts = [
          b.d30 > 0 && <Tag key="a" color="volcano">{`逾期≤30 ${fmt(b.d30)}`}</Tag>,
          b.d60 > 0 && <Tag key="b" color="magenta">{`30-60 ${fmt(b.d60)}`}</Tag>,
          b.d90 > 0 && <Tag key="c" color="red">{`60-90 ${fmt(b.d90)}`}</Tag>,
          b.d90p > 0 && <Tag key="d" color="red">{`90+ ${fmt(b.d90p)}`}</Tag>,
          b.current > 0 && <Tag key="e">{`未到期 ${fmt(b.current)}`}</Tag>,
        ].filter(Boolean)
        return parts.length ? <Space size={4}>{parts}</Space> : <Text type="secondary">无未结</Text>
      },
    },
  ]
  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="期初为 0（历史旧账不迁移，见数据迁移方案）；对账单/账龄覆盖新账。已冲销单据不计入。" />
      <Table<StatementRow> rowKey="customerId" size="small" loading={loading} columns={columns} dataSource={rows}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty description="暂无往来数据" /> }} />
    </div>
  )
}

/** 利润视图：月度总览 + 客户下钻 */
function ProfitTab() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [p, setP] = useState<ProfitView | null>(null)
  const load = useCallback(async () => {
    try { setP(await api<ProfitView>(`/profit?month=${month}`)) }
    catch (e) { message.error('加载失败：' + (e as Error).message) }
  }, [month])
  useEffect(() => { load() }, [load])
  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Text>月份</Text>
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 160 }} />
      </Space>
      {p && (
        <div>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col span={5}><Card size="small"><Statistic title="营收（收款核销）" value={p.revenue} precision={2} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="材料成本（来料）" value={p.material} precision={2} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="制费（六类）" value={p.manufactureCost} precision={2} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="总成本" value={p.totalCost} precision={2} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="利润" value={p.profit} precision={2} valueStyle={{ color: p.profit >= 0 ? '#3f8600' : '#cf1322' }} /></Card></Col>
          </Row>
          <Card size="small" title="营收按客户下钻（现金收付制：收款核销计入当月）" style={{ marginBottom: 12 }}>
            {p.revenueByCustomer.length === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本月暂无收款核销" />
              : <Table<{ customer: string; amount: number }> rowKey="customer" size="small" pagination={false}
                  dataSource={p.revenueByCustomer}
                  columns={[
                    { title: '客户', dataIndex: 'customer' },
                    { title: '收款核销额', dataIndex: 'amount', render: (v: number) => fmt(v) },
                  ]} />}
          </Card>
          <Card size="small" title={`${p.month} 成本构成`}>
            <Descriptions size="small" column={3} bordered>
              <Descriptions.Item label="材料（来料自动汇总）">{fmt(p.material)}</Descriptions.Item>
              {COST_CATEGORY_ORDER.map((c) => (
                <Descriptions.Item key={c} label={COST_CATEGORY_LABEL[c]}>{fmt((p.costs as Record<string, number>)[c])}</Descriptions.Item>
              ))}
              <Descriptions.Item label="制费合计">{fmt(p.manufactureCost)}</Descriptions.Item>
            </Descriptions>
          </Card>
        </div>
      )}
    </div>
  )
}

/** 月度成本：固定六类手填 + 材料自动汇总展示 */
function CostTab() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [material, setMaterial] = useState(0)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await api<MonthlyCost[]>(`/monthly-costs?month=${month}`)
      const d: Record<string, number> = {}
      for (const c of list) d[c.category] = c.amount
      setDraft(d)
    } catch (e) { message.error('加载失败：' + (e as Error).message) }
    const pf = await api<ProfitView>(`/profit?month=${month}`)
    setMaterial(pf.material)
  }, [month])
  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    try {
      for (const c of COST_CATEGORY_ORDER) {
        await api('/monthly-costs', { method: 'POST', body: { month, category: c, amount: draft[c] ?? 0 } })
      }
      message.success('六类成本已保存')
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setSaving(false) }
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Text>月份</Text>
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 160 }} />
        <Text type="secondary">材料成本自动从来料登记汇总：<Text strong>{fmt(material)}</Text> 元（不需手填）</Text>
      </Space>
      <Card size="small" title="固定六类（每类每月一笔，0 表示无）" extra={<Button type="primary" loading={saving} onClick={save}>保存六类</Button>}>
        <Table<{ category: string; label: string; amount: number }>
          rowKey="category" size="small" pagination={false}
          dataSource={COST_CATEGORY_ORDER.map((c) => ({ category: c, label: COST_CATEGORY_LABEL[c], amount: draft[c] ?? 0 }))}
          columns={[
            { title: '类别', dataIndex: 'label', width: 120 },
            { title: '金额（元）', width: 220, render: (_, r) => (
              <InputNumber style={{ width: 200 }} min={0} value={draft[r.category] ?? 0}
                onChange={(v) => setDraft((p) => ({ ...p, [r.category]: (v as number) ?? 0 }))} />
            ) },
            { title: '说明', render: (_, r) => <Text type="secondary" style={{ fontSize: 12 }}>
              {r.category === 'labor' ? '车间人工（月结总额）' : r.category === 'material' ? '' : `${r.label} 月固定/变动支出`}
            </Text> },
          ]}
        />
      </Card>
    </div>
  )
}

export default AccountingPage
