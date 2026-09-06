import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Checkbox, InputNumber, Select, Space, Table, Tag, Typography, message } from 'antd'
import { api } from '../lib/api'
import { PRODUCT_TYPE_LABEL } from '../lib/labels'

interface Product { id: number; name: string; type: string; safetyStock: number }
interface ProcessDict { id: number; key: string; name: string; wcKey: string; wcName?: string | null; sortOrder: number }
interface RouteRow {
  processId: number; seq: number
  unitSeconds?: number | null; changeoverMinutes?: number | null
  processKey?: string; processName?: string; wcKey?: string; wcName?: string | null
}
interface EditRow {
  processId: number
  included: boolean
  unitSeconds?: number | null
  changeoverMinutes?: number | null
}

/** 把已保存的 routes 摊平成「字典 × 行」可编辑结构；未勾选的工序居前展示用于一键套模板 */
function dictToEditable(dict: ProcessDict[], existing: RouteRow[]): EditRow[] {
  const byId = new Map(existing.map((r) => [r.processId, r]))
  return dict.map((d) => {
    const e = byId.get(d.id)
    return {
      processId: d.id,
      included: !!e,
      unitSeconds: e ? e.unitSeconds ?? null : null,
      changeoverMinutes: e ? e.changeoverMinutes ?? 0 : 0,
    }
  })
}

/** I13：产品工序路线配置——决定排期工期；服务端整表替换（事务）。 */
export default function ProcessRouteCard() {
  const [products, setProducts] = useState<Product[]>([])
  const [dict, setDict] = useState<ProcessDict[]>([])
  const [productId, setProductId] = useState<number | null>(null)
  const [rows, setRows] = useState<EditRow[]>([])
  const [original, setOriginal] = useState<EditRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<Product[]>('/products').then(setProducts).catch(() => {})
    api<ProcessDict[]>('/products/processes').then(setDict).catch(() => {})
  }, [])

  const dictById = useMemo(() => new Map(dict.map((d) => [d.id, d])), [dict])

  async function loadProduct(pid: number | null) {
    setProductId(pid)
    if (!pid) { setRows([]); setOriginal([]); return }
    setLoading(true)
    try {
      const rs = await api<RouteRow[]>(`/products/${pid}/process-routes`)
      const editable = dictToEditable(dict, rs)
      setRows(editable)
      setOriginal(editable)
    } catch (e) {
      message.error('加载工序路线失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function patchRow(i: number, p: Partial<EditRow>) {
    setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, ...p } : x)))
  }

  /** 互换 rows 中两个位置（仅调整显示顺序；勾选状态在 included 上） */
  function swap(a: number, b: number) {
    setRows((rs) => {
      const next = [...rs]
      ;[next[a], next[b]] = [next[b], next[a]]
      return next
    })
  }

  function applyTemplate() {
    setRows((rs) => rs.map((r) => ({ ...r, included: true, unitSeconds: null, changeoverMinutes: 0 })))
  }
  function clearAll() {
    setRows((rs) => rs.map((r) => ({ ...r, included: false, unitSeconds: null, changeoverMinutes: 0 })))
  }

  const includedIdx = rows.map((r, i) => (r.included ? i : -1)).filter((i) => i >= 0)
  const dirty = JSON.stringify(rows) !== JSON.stringify(original)

  async function save() {
    if (!productId) return
    const items = includedIdx.map((idx) => {
      const r = rows[idx]
      return {
        processId: r.processId,
        unitSeconds: r.unitSeconds == null || (r.unitSeconds as unknown) === '' ? null : Number(r.unitSeconds),
        changeoverMinutes: r.changeoverMinutes == null ? 0 : Number(r.changeoverMinutes),
      }
    })
    setSaving(true)
    try {
      const r = await api<{ ok: boolean; count: number }>(`/products/${productId}/process-routes`, {
        method: 'PUT',
        body: { items },
      })
      message.success(`已保存 ${r.count} 道工序路线`)
      // 重拉作为新的干净基准
      const rs = await api<RouteRow[]>(`/products/${productId}/process-routes`)
      const editable = dictToEditable(dict, rs)
      setRows(editable)
      setOriginal(editable)
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="产品工序路线（决定排期工期）" size="small">
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text>产品：</Typography.Text>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="选择产品以编辑路线"
          style={{ minWidth: 320 }}
          value={productId ?? undefined}
          onChange={(v) => loadProduct(v ?? null)}
          options={products.map((p) => ({
            value: p.id,
            label: `${p.name}（${PRODUCT_TYPE_LABEL[p.type] ?? p.type}）`,
          }))}
        />
        <Button onClick={applyTemplate} disabled={!productId}>套用字典模板（全勾选）</Button>
        <Button onClick={clearAll} disabled={!productId}>全部清空</Button>
        <Button type="primary" loading={saving} disabled={!dirty || !productId} onClick={save}>
          保存路线
        </Button>
        {dirty && <Typography.Text type="warning" style={{ fontSize: 12 }}>有未保存改动</Typography.Text>}
      </Space>
      <Table<EditRow>
        dataSource={rows}
        rowKey={(r) => r.processId}
        size="small"
        pagination={false}
        loading={loading || !dict.length}
        locale={{ emptyText: '请先选择产品' }}
        columns={[
          {
            title: '勾选', width: 60,
            render: (_, _r, i) => (
              <Checkbox checked={rows[i].included} onChange={(e) => patchRow(i, { included: e.target.checked })} />
            ),
          },
          {
            title: '工序 / 泳道',
            render: (_, _r, i) => {
              const d = dictById.get(rows[i].processId)
              return (
                <Space size={6}>
                  <span>{d?.name ?? `#${rows[i].processId}`}</span>
                  <Tag color="blue">{d?.wcName ?? d?.wcKey ?? '-'}</Tag>
                </Space>
              )
            },
          },
          {
            title: '单件耗时(秒)', width: 140,
            render: (_, _r, i) => (
              <InputNumber
                min={0}
                step={1}
                style={{ width: '100%' }}
                value={rows[i].unitSeconds ?? null}
                placeholder="未填（工期 1 天占位）"
                disabled={!rows[i].included}
                onChange={(v) => patchRow(i, { unitSeconds: v ?? null })}
              />
            ),
          },
          {
            title: '换型(分钟)', width: 110,
            render: (_, _r, i) => (
              <InputNumber
                min={0}
                step={1}
                style={{ width: '100%' }}
                value={rows[i].changeoverMinutes ?? 0}
                disabled={!rows[i].included}
                onChange={(v) => patchRow(i, { changeoverMinutes: v ?? 0 })}
              />
            ),
          },
          {
            title: '顺序', width: 130,
            render: (_, _r, i) => {
              const pos = includedIdx.indexOf(i)
              if (pos === -1) return <Typography.Text type="secondary">—</Typography.Text>
              return (
                <Space size={4}>
                  <Button size="small" disabled={pos === 0} onClick={() => swap(includedIdx[pos - 1], i)}>↑</Button>
                  <Button size="small" disabled={pos === includedIdx.length - 1} onClick={() => swap(i, includedIdx[pos + 1])}>↓</Button>
                  <Tag>#{pos + 1}</Tag>
                </Space>
              )
            },
          },
        ]}
      />
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        单件耗时控制排期工期推算（qty × 单件耗时 ÷ 设备数 ÷ 班次分钟数 → ceil 天）；未填 → 该工序占位 1 天。换型时间只显示记录，排期工期未消费。
      </Typography.Text>
    </Card>
  )
}