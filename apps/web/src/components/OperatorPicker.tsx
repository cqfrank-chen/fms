import { useEffect, useState } from 'react'
import { Select, Tooltip } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import { api } from '../lib/api'
import { getOperatorId, setOperatorId } from '../lib/operator'

interface OperatorRow { id: number; name: string; boundPc?: string | null }

/** 顶栏「本机操作人」：免登录留痕的绑定入口（选择后随请求头发送，存本机浏览器） */
export default function OperatorPicker() {
  const [ops, setOps] = useState<OperatorRow[]>([])
  const [cur, setCur] = useState<number | null>(getOperatorId())

  useEffect(() => {
    api<OperatorRow[]>('/operators').then(setOps).catch(() => {})
  }, [])

  return (
    <Tooltip title="免登录留痕：选择本机操作人后，录单 / 报工 / 出入库 / 收付款都会记录经办人（存本机浏览器）">
      <Select
        size="small"
        variant="borderless"
        style={{ minWidth: 176 }}
        value={cur ?? undefined}
        placeholder={<span style={{ color: 'rgba(255,255,255,.75)' }}>本机操作人未绑定</span>}
        suffixIcon={<UserOutlined style={{ color: 'rgba(255,255,255,.75)' }} />}
        popupMatchSelectWidth={false}
        options={ops.map((o) => ({ value: o.id, label: `${o.name}${o.boundPc ? `（${o.boundPc}）` : ''}` }))}
        onChange={(v: number) => { setCur(v); setOperatorId(v) }}
        allowClear
        onClear={() => { setCur(null); setOperatorId(null) }}
      />
    </Tooltip>
  )
}
