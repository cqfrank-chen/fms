import { Button, Descriptions, Modal, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { INVOICE_STATE_COLOR, INVOICE_STATE_LABEL, PACK_LABEL, STATUS_LABEL } from '../lib/labels'
import { fmtCents } from '../lib/money'
import type { Order, OrderLine, PackagingSpec } from '../lib/types'

/**
 * 订单详情弹窗（共享组件）：单头 + 全部行（刻字/包装/币种单价）。
 * 复用方：OrdersPage（列表「详情」）、SchedulingPage（任务简介「查看完整订单」）。
 * I11 抽离：原 OrdersPage 内部实现上移为共享组件，消除两处重复。
 */
export default function OrderDetailModal({
  order, open, onClose,
}: {
  order: Order | null
  open: boolean
  onClose: () => void
}) {
  if (!order || !open) return <Modal open={false} onCancel={onClose} footer={null} />
  const packText = (p?: PackagingSpec | null) => {
    if (!p || !Object.keys(p).length) return '—'
    return Object.entries(p).map(([k, v]) => `${PACK_LABEL[k] ?? k}${v ? '：' + v : ''}`).join('；')
  }
  return (
    <Modal title={`订单详情 ${order.orderNo}`} open onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={760}>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="客户">{order.customerName}</Descriptions.Item>
        <Descriptions.Item label="PO号">{order.poNo || '—'}</Descriptions.Item>
        <Descriptions.Item label="状态"><Tag color="processing">{STATUS_LABEL[order.status]}</Tag></Descriptions.Item>
        <Descriptions.Item label="交期">{dayjs(order.dueDate).format('YYYY-MM-DD')}</Descriptions.Item>
        <Descriptions.Item label="备注" span={2}>{order.note || '—'}</Descriptions.Item>
        {/* 开票进度（I16）：已开票金额实时聚合自未作废发票；与收款核销互不影响 */}
        <Descriptions.Item label="订单金额">{order.totalAmountCents != null ? fmtCents(order.totalAmountCents) : (order.totalAmount ?? '—')} 元</Descriptions.Item>
        <Descriptions.Item label="已开票（含税）">{fmtCents(order.invoicedCents ?? 0)} 元</Descriptions.Item>
        <Descriptions.Item label="未开票余额">
          {order.overInvoiced
            ? <Tag color="error">已超额开票</Tag>
            : `${fmtCents(order.uninvoicedCents ?? 0)} 元`}
        </Descriptions.Item>
        <Descriptions.Item label="开票状态">
          <Tag color={INVOICE_STATE_COLOR[order.invoiceState ?? 'none']}>
            {INVOICE_STATE_LABEL[order.invoiceState ?? 'none']}
          </Tag>
          {order.overInvoiced && <Tag color="error">超额</Tag>}
        </Descriptions.Item>
      </Descriptions>
      <Table<OrderLine>
        rowKey={(_, i) => String(i)}
        size="small"
        pagination={false}
        columns={[
          { title: '产品', dataIndex: 'productName' },
          { title: '数量', dataIndex: 'quantity', width: 90, align: 'right' },
          { title: '单价', dataIndex: 'unitPrice', width: 90, align: 'right', render: (v: number) => v.toFixed(2) },
          { title: '币种', dataIndex: 'currency', width: 70 },
          { title: '刻字', dataIndex: 'engraving', width: 140, render: (v?: string | null) => v || '—' },
          { title: '包装要求', dataIndex: 'packaging', render: packText },
        ]}
        dataSource={order.lines}
      />
    </Modal>
  )
}
