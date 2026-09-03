import { Space, Typography } from 'antd'
import CrudResource from '../components/CrudResource'
import type { FieldConfig } from '../components/CrudResource'
import { PRODUCT_TYPE_LABEL, SETTLEMENT_LABEL } from '../lib/labels'
import { api } from '../lib/api'
import { useEffect, useState } from 'react'
import type { ColumnsType } from 'antd/es/table'

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

/** 设置页：主数据四实体（spec §3），列表 + 弹窗直接生效 */
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
      </div>
    </div>
  )
}
