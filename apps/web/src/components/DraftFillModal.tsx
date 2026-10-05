import { useState } from 'react'
import { Alert, Button, Modal, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../lib/api'
import { fmtCents } from '../lib/money'
import type { Order, OrderLine, PendingItem } from '../lib/types'

/**
 * 草稿订单「补全」面板（I17）
 * ------------------------------------------------------------------
 * 识单结果落草稿后，缺价/缺交期/缺数量/未建档的产品或客户都会写成中文待补项。
 * 本面板把这些待补项集中展示，并支持：
 *   · **一键从报价记录取价**（POST /orders/:id/fill-quote-prices，命中即写回并清标记，留 priceFrom=quote 追溯）；
 *   · 跳转「编辑订单」逐项人工补全（客户/交期/产品/数量）。
 * 待补项未清空时订单**不能确认**（服务端 confirmOrder 拦截），避免脏数据流入计划单与应收。
 */

const { Text } = Typography

const CODE_LABEL: Record<string, string> = {
  customer_not_filed: '客户未建档',
  due_date_missing: '缺交期',
  price_missing: '缺单价',
  quantity_missing: '缺数量',
  product_not_filed: '产品未建档',
  no_product_lines: '无产品行',
  line_pending: '行级待补',
}
const CODE_COLOR: Record<string, string> = {
  customer_not_filed: 'red',
  due_date_missing: 'orange',
  price_missing: 'volcano',
  quantity_missing: 'gold',
  product_not_filed: 'magenta',
  no_product_lines: 'red',
  line_pending: 'blue',
}

interface FillResult {
  order: Order
  filled: Array<{ lineId: number; productName: string; unitPrice: number; quoteId: number; ruleText: string; message: string }>
  missed: Array<{ lineId: number; productName: string; message: string }>
  message: string
}

function PendingList({ items }: { items: PendingItem[] }) {
  if (!items.length) return <Text type="success">✓ 没有待补项</Text>
  return (
    <Space direction="vertical" size={2} style={{ display: 'flex' }}>
      {items.map((x, i) => (
        <div key={i} style={{ fontSize: 13 }}>
          <Tag color={CODE_COLOR[x.code] ?? 'default'}>{CODE_LABEL[x.code] ?? x.code}</Tag>
          {x.message}
        </div>
      ))}
    </Space>
  )
}

export default function DraftFillModal({ order, onClose, onChanged, onEdit }: {
  order: Order | null
  onClose: () => void
  onChanged?: () => void
  onEdit?: (o: Order) => void
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FillResult | null>(null)
  /** 取价后刷新出来的最新单据（优先于外部传入的旧快照） */
  const [fresh, setFresh] = useState<Order | null>(null)

  const cur = fresh && order && fresh.id === order.id ? fresh : order
  const orderPending = Array.isArray(cur?.pendingItems) ? cur!.pendingItems! : []

  async function doFill() {
    if (!cur) return
    setBusy(true)
    try {
      const r = await api<FillResult>(`/orders/${cur.id}/fill-quote-prices`, { method: 'POST' })
      setResult(r)
      setFresh(r.order)
      if (r.filled.length) message.success(r.message)
      else message.warning(r.message)
      onChanged?.()
    } catch (e) {
      message.error('补价失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const lineCols: ColumnsType<OrderLine> = [
    { title: '产品（识别原文）', render: (_: unknown, l) => l.productNameText || l.productName || '—' },
    { title: '数量', dataIndex: 'quantity', width: 80, align: 'right' },
    { title: '单价', width: 100, align: 'right', render: (_: unknown, l) => (l.pendingItems?.some((x) => x.code === 'price_missing') ? <Tag color="volcano">缺价</Tag> : fmtCents(Math.round(Number(l.unitPrice) * 100))) },
    { title: '单价来源', width: 100, render: (_: unknown, l) => (l.priceSource === 'quote' ? <Tag color="blue">报价记录</Tag> : <Text type="secondary">单据自带</Text>) },
    {
      title: '待补', render: (_: unknown, l) => (l.pendingItems?.length
        ? <Space size={4} wrap>{l.pendingItems.map((x, i) => <Tag key={i} color={CODE_COLOR[x.code] ?? 'default'}>{CODE_LABEL[x.code] ?? x.code}</Tag>)}</Space>
        : <Tag color="success">无</Tag>),
    },
  ]

  return (
    <Modal
      open={!!order}
      title={cur ? `补全草稿订单 ${cur.orderNo}` : '补全草稿订单'}
      onCancel={() => { setResult(null); setFresh(null); onClose() }}
      width={860}
      footer={[
        <Button key="close" onClick={() => { setResult(null); setFresh(null); onClose() }}>关闭</Button>,
        onEdit && cur && <Button key="edit" onClick={() => { onEdit(cur); setResult(null); setFresh(null); onClose() }}>去编辑订单逐项补全</Button>,
        <Button key="fill" type="primary" loading={busy} onClick={doFill} disabled={!cur}>一键从报价记录取价</Button>,
      ]}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="待补项未清空时不能确认订单"
        description="确认订单会生成计划单并进入排产/应收链路，因此缺价、缺交期、未建档的单据必须先补齐（下方「一键取价」可批量补价；客户/产品/交期请走「去编辑订单」）。"
      />

      <div style={{ marginBottom: 8 }}><Text strong>单头待补项</Text></div>
      <PendingList items={orderPending} />

      {result && (
        <Alert
          style={{ marginTop: 12 }}
          type={result.missed.length ? 'warning' : 'success'}
          showIcon
          message={result.message}
          description={(
            <div style={{ fontSize: 12 }}>
              {result.filled.map((f) => (
                <div key={f.lineId}>✓ {f.productName} → {f.unitPrice.toFixed(2)}（报价 #{f.quoteId}，{f.ruleText}）</div>
              ))}
              {result.missed.map((m) => <div key={m.lineId}>✗ {m.productName}：{m.message}</div>)}
            </div>
          )}
        />
      )}

      <div style={{ marginTop: 14, marginBottom: 6 }}><Text strong>产品行</Text></div>
      <Table<OrderLine>
        rowKey={(l) => String(l.id ?? l.productId)}
        size="small"
        dataSource={cur?.lines ?? []}
        columns={lineCols}
        pagination={false}
        scroll={{ x: 760 }}
      />
    </Modal>
  )
}
