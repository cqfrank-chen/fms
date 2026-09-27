import { useEffect, useState } from 'react'
import { Select, Tooltip } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { api } from '../lib/api'
import { getOperatorId, setOperatorId } from '../lib/operator'
import { getUser } from '../lib/token'

interface OperatorRow { id: number; name: string; boundPc?: string | null }

/**
 * 顶栏「本机操作人」：免登录留痕的绑定入口。
 * 登录用户若已绑定操作人（users.operator_id），则自动锁定为该操作人（避免重复选择）；
 * 未绑定时保持原行为（本机浏览器选择，随 X-Operator-Id 头发送，后端留痕自动回退该值）。
 */
export default function OperatorPicker() {
  const [ops, setOps] = useState<OperatorRow[]>([])
  const [cur, setCur] = useState<number | null>(getOperatorId())
  const bound = getUser()?.operatorId ?? null

  useEffect(() => {
    api<OperatorRow[]>('/operators').then(setOps).catch(() => {})
  }, [])

  // 登录用户已绑定操作人：自动写入本机并覆盖旧值，保证留痕与账号一致
  useEffect(() => {
    if (bound != null && getOperatorId() !== bound) {
      setOperatorId(bound)
      setCur(bound)
    }
  }, [bound])

  if (bound != null) {
    const o = ops.find((x) => x.id === bound)
    return (
      <Tooltip title="已绑定登录用户的操作人（经办人留痕自动取该值）；如需调整请管理员在「设置 → 用户账号」修改绑定">
        <div style={{ color: 'rgba(255,255,255,.9)', fontSize: 13, minWidth: 140 }}>
          <UserOutlined style={{ marginRight: 6, color: 'rgba(255,255,255,.75)' }} />
          {o ? o.name : '操作人 #' + bound}
          <LockOutlined style={{ marginLeft: 6, fontSize: 11, color: 'rgba(255,255,255,.6)' }} />
        </div>
      </Tooltip>
    )
  }

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
        options={ops.map((o) => ({ value: o.id, label: o.name + (o.boundPc ? '（' + o.boundPc + '）' : '') }))}
        onChange={(v: number) => { setCur(v); setOperatorId(v) }}
        allowClear
        onClear={() => { setCur(null); setOperatorId(null) }}
      />
    </Tooltip>
  )
}
