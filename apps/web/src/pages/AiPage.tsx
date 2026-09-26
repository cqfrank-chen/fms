import { useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Card, Empty, Input, Space, Spin, Tabs, Tag, Typography, message,
} from 'antd'
import { SendOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { api } from '../lib/api'

const { Text } = Typography

/** ===== 查数（function calling）===== */
interface QaCall { name: string; args: Record<string, string>; result: string }
interface QaResp { question: string; answer: string; calls: QaCall[]; provider: 'llm' | 'router' }
interface Msg { role: 'user' | 'ai'; text: string; calls?: QaCall[]; provider?: string }

const QUICK_QUESTIONS = [
  '这个月利润怎么样',
  '有没有订单超期',
  '应收有没有逾期的',
  '哪些产品库存低于安全线',
  '查一下所有计划单',
]

function ChatTab() {
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'ai', text: '你好，我是厂里数据助手。可以问我订单、库存、应收、排期、利润等经营数据（点下方快捷问题试试）。' }])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, busy])

  async function ask(text: string) {
    if (!text.trim() || busy) return
    setMsgs((m) => [...m, { role: 'user', text }])
    setQ('')
    setBusy(true)
    try {
      const r = await api<QaResp>('/ai/ask', { method: 'POST', body: { question: text } })
      setMsgs((m) => [...m, { role: 'ai', text: r.answer, calls: r.calls, provider: r.provider }])
    } catch (e) {
      setMsgs((m) => [...m, { role: 'ai', text: '查询失败：' + (e as Error).message }])
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 260px)', minHeight: 420 }}>
      <div style={{ flex: 1, overflow: 'auto', background: '#fff', borderRadius: 8, padding: 16, border: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '82%', padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 13,
              background: m.role === 'user' ? '#1677ff' : '#f5f5f5', color: m.role === 'user' ? '#fff' : '#333',
            }}>
              {m.text}
              {m.calls && m.calls.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {m.calls.map((c, ci) => (
                    <Tag key={ci} color="blue" style={{ fontSize: 11 }}>{c.name}
                      {Object.keys(c.args).length > 0 ? ` ${Object.entries(c.args).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}
                    </Tag>
                  ))}
                </div>
              )}
              {m.provider && <div style={{ fontSize: 10, color: '#999', marginTop: 2 }}>{m.provider === 'router' ? 'mock 路由查询' : 'AI 查询'}</div>}
            </div>
          </div>
        ))}
        {busy && <div><Spin size="small" /> <Text type="secondary" style={{ fontSize: 12 }}>查询中…</Text></div>}
        <div ref={bottomRef} />
      </div>
      <Space wrap style={{ marginTop: 8 }} size={[4, 4]}>
        {QUICK_QUESTIONS.map((x) => (
          <Button key={x} size="small" disabled={busy} onClick={() => ask(x)}>{x}</Button>
        ))}
      </Space>
      <Space.Compact style={{ marginTop: 8, width: '100%' }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="如：上个月利润多少 / 逾期应收 / 排程超期任务"
          onPressEnter={() => ask(q)} disabled={busy} />
        <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={() => ask(q)}>问</Button>
      </Space.Compact>
    </div>
  )
}

/** ===== 利润月报摘要（模板渲染 + LLM 摘要 + 数字回核）===== */
interface SummaryResp {
  month: string; summary: string; provider: 'llm' | 'template'; mock: boolean
  check: { ok: boolean; suspicious: string[] }
}

function ReportTab() {
  const [month, setMonth] = useState<Dayjs | null>(dayjs())
  const [resp, setResp] = useState<SummaryResp | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(m: Dayjs) {
    setBusy(true); setResp(null)
    try {
      setResp(await api<SummaryResp>(`/ai/report-summary?month=${m.format('YYYY-MM')}`))
    } catch (e) {
      message.error('摘要生成失败：' + (e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%', maxWidth: 760 }}>
      <Space>
        <Text strong>选择月份</Text>
        <Input type="month" value={month?.format('YYYY-MM')}
          onChange={(e) => {
            const d = dayjs(e.target.value + '-01')
            setMonth(d)
            if (e.target.value) load(d)
          }} style={{ width: 160 }} />
        <Button type="primary" size="small" loading={busy} onClick={() => month && load(month)}>生成 AI 执行摘要</Button>
      </Space>
      {busy && <Spin />}
      {resp && (
        <Card size="small" title={`${resp.month} 利润月报 · AI 执行摘要`}
          extra={
            <Space size={4}>
              <Tag color={resp.provider === 'llm' ? 'blue' : 'default'}>{resp.provider === 'llm' ? 'AI 摘要' : '系统模板'}</Tag>
              {resp.check.ok
                ? <Tag color="green">数字回核通过</Tag>
                : <Tag color="red">⚠ 疑似幻觉：{resp.check.suspicious.join(', ')}</Tag>}
            </Space>
          }>
          <div style={{ fontSize: 14, lineHeight: 1.8 }}>{resp.summary}</div>
          <Alert style={{ marginTop: 10 }} type="info" showIcon
            message="口径提示" description="营收=当月收款核销（现金收付制）；成本=材料（来料月汇总）+ 制造费用（六类月填）。摘要只解释系统算出的数字，不生成数字。" />
        </Card>
      )}
      {!resp && !busy && <Empty description="选月份后点「生成 AI 执行摘要」查看" />}
    </Space>
  )
}

/** AI 一期页：查数问答 / 利润月报摘要 */
export default function AiPage() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>AI 助手 <Text type="secondary" style={{ fontSize: 13 }}>（function calling 查数 · 利润月报摘要 · 顶部铃铛为规则预警）</Text></Typography.Title>
      <Tabs items={[
        { key: 'ask', label: '💬 查数问答', children: <ChatTab /> },
        { key: 'report', label: '📈 利润月报摘要', children: <ReportTab /> },
      ]} />
    </div>
  )
}
