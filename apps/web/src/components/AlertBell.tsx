import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Drawer, Empty, Space, Tag, Typography } from 'antd'
import { BellOutlined } from '@ant-design/icons'

/** 规则预警条目（与后端 rule-alerts.service 对齐） */
export interface AiAlert {
  type: 'low_stock' | 'recv_overdue' | 'due_conflict'
  level: 'danger' | 'warning'
  title: string
  detail: string
  refId?: number | string
  days?: number
}
interface AlertsResp { alerts: AiAlert[]; counts: Record<string, number>; generatedAt: string }

const TYPE_META: Record<AiAlert['type'], { label: string; color: string }> = {
  low_stock: { label: '安全库存', color: 'blue' },
  recv_overdue: { label: '应收逾期', color: 'purple' },
  due_conflict: { label: '交期冲突', color: 'orange' },
}

/** 顶栏预警铃铛：轮询 /api/ai/alerts，红点计数 + 抽屉清单 */
export default function AlertBell() {
  const [resp, setResp] = useState<AlertsResp | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/alerts')
      if (!res.ok) return
      setResp(await res.json())
    } catch { /* 后端不可达时不打扰 */ }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

  const total = resp?.alerts.length ?? 0
  const danger = resp?.alerts.filter((a) => a.level === 'danger').length ?? 0

  return (
    <>
      <Badge count={total} size="small" offset={[-2, 2]}>
        <Button
          type="text"
          icon={<BellOutlined style={{ color: total ? (danger ? '#ff7875' : '#ffd666') : '#fff', fontSize: 18 }} />}
          onClick={() => setOpen(true)}
          aria-label="规则预警"
        />
      </Badge>
      <Drawer
        title={<Space>规则预警 {total > 0 && <Tag color={danger ? 'red' : 'orange'}>{danger ? `${danger} 严重` : `${total} 条`}</Tag>}</Space>}
        open={open}
        onClose={() => setOpen(false)}
        width={520}
        extra={<Button size="small" onClick={load}>刷新</Button>}
      >
        {!total ? (
          <Empty description="无预警 —— 三类规则均正常（安全库存 / 应收逾期 / 交期冲突）" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {resp!.alerts.map((a, i) => (
              <div key={i} style={{
                border: '1px solid ' + (a.level === 'danger' ? '#ffa39e' : '#ffe58f'),
                borderLeft: '4px solid ' + (a.level === 'danger' ? '#f5222d' : '#faad14'),
                background: a.level === 'danger' ? '#fff2f0' : '#fffbe6',
                borderRadius: 6, padding: '8px 12px',
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Tag color={TYPE_META[a.type].color} style={{ marginRight: 0 }}>{TYPE_META[a.type].label}</Tag>
                  <Typography.Text strong style={{ flex: 1, fontSize: 13 }}>{a.title}</Typography.Text>
                  {a.days != null && <Tag color={a.level === 'danger' ? 'red' : 'gold'}>{a.days} 天</Tag>}
                </div>
                <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{a.detail}</div>
              </div>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              预警为确定性规则引擎判定（I12 一期不含 AI 解释）；库存请到仓储看板、应收见账目往来款、超期行见排程红框处理。
            </Typography.Text>
          </Space>
        )}
      </Drawer>
    </>
  )
}
