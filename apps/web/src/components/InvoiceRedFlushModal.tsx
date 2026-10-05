import { useEffect, useState } from 'react'
import { Alert, Col, Collapse, DatePicker, Descriptions, Input, InputNumber, Modal, Row, Space, Tag, Typography, message } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { INVOICE_TYPE_LABEL } from '../lib/labels'
import { fmtCents, fromCents, toCents } from '../lib/money'
import type { Invoice } from '../lib/types'

const { Text } = Typography

/**
 * 红冲弹窗（I16 红字发票）：跨月开错票不能作废，用负数红字发票冲减。
 * ------------------------------------------------------------------
 * 极简交互：红字票号 + 红冲金额（默认全额，可改小做部分红冲）+ 日期（默认今天）+ 冲红原因（默认「红冲重开」）。
 * 其余（票种/税率/金额拆分/备注）收进「高级」，能力不删除。
 */
export default function InvoiceRedFlushModal({
  open, invoice, onClose,
}: {
  open: boolean
  /** 被冲的原票（必须为未作废、非红字票） */
  invoice: Invoice | null
  onClose: (reload: boolean) => void
}) {
  const [invoiceNo, setInvoiceNo] = useState('')
  const [amountYuan, setAmountYuan] = useState<number | undefined>()
  const [issueDate, setIssueDate] = useState<Dayjs | null>(dayjs())
  const [reason, setReason] = useState('红冲重开')
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)

  const remainCents = Math.max(0, invoice?.redRemainCents ?? Math.abs(invoice?.amountInclCents ?? 0))

  useEffect(() => {
    if (!open) return
    const amount = Math.max(0, invoice?.redRemainCents ?? Math.abs(invoice?.amountInclCents ?? 0))
    setInvoiceNo('')
    setAmountYuan(amount > 0 ? fromCents(amount) : undefined) // 默认全额红冲
    setIssueDate(dayjs())
    setReason('红冲重开')
    setRemark('')
  }, [open, invoice])

  async function submit() {
    if (!invoice) return
    if (!invoiceNo.trim()) { message.warning('请填写红字发票号（红字票必须有自己的真实票号）'); return }
    const cents = toCents(amountYuan ?? 0)
    if (cents <= 0) { message.warning('请填写红冲金额（正数，须大于 0）'); return }
    if (cents > remainCents) { message.warning(`红冲金额超过可红冲余额（${fmtCents(remainCents)} 元）`); return }
    if (!reason.trim()) { message.warning('请填写冲红原因'); return }
    if (!issueDate) { message.warning('请选择红冲日期'); return }
    setSaving(true)
    try {
      const res = await api<Invoice>(`/invoices/${invoice.id}/red-flush`, {
        method: 'POST',
        body: {
          invoiceNo: invoiceNo.trim(),
          amountInclCents: cents,
          issueDate: issueDate.format('YYYY-MM-DD'),
          reason: reason.trim(),
          remark: remark.trim() || undefined,
        },
      })
      message.success(`红字发票 ${res.invoiceNo} 已开具（${fmtCents(res.amountInclCents)} 元），原票 ${invoice.invoiceNo} 状态已置「已红冲」`)
      onClose(true)
    } catch (e) {
      message.error((e as Error).message)
    } finally { setSaving(false) }
  }

  return (
    <Modal
      title={invoice ? `红冲发票 ${invoice.invoiceNo}` : '红冲发票'}
      open={open} onCancel={() => onClose(false)} onOk={submit} confirmLoading={saving}
      okText="开具红字发票" okButtonProps={{ danger: true }} width={620}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Alert
          type="warning" showIcon
          message="红冲用于跨月开错票（当月错票请用「作废」）：将开具一张**负数金额**的红字发票冲减原票，原票状态置「已红冲」。"
          description={invoice ? (
            <span>
              原票 <Text strong>{invoice.invoiceNo}</Text>（{INVOICE_TYPE_LABEL[invoice.invoiceType] ?? invoice.invoiceType}）·
              含税 <Text strong>{fmtCents(invoice.amountInclCents)}</Text> 元 ·
              已红冲 {fmtCents(invoice.redFlushedCents ?? 0)} 元 ·
              可红冲 <Text strong>{fmtCents(remainCents)}</Text> 元
            </span>
          ) : undefined}
        />
        <Row gutter={12}>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>红字发票号 *</Text>
            <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="红字票的真实票号（必填）" />
          </Col>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>红冲金额（正数，元）*</Text>
            <InputNumber style={{ width: '100%' }} min={0.01} max={fromCents(remainCents)} precision={2}
              value={amountYuan} onChange={(v) => setAmountYuan((v as number) ?? undefined)} />
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>红冲日期 *</Text>
            <DatePicker style={{ width: '100%' }} value={issueDate} onChange={(v) => setIssueDate(v)} />
          </Col>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>冲红原因 *</Text>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：开错客户 / 金额有误 / 客户退回重开" />
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 12 }}>
          默认按可红冲余额**全额红冲**（金额自动带出）；改小即为**部分红冲**，可多次红冲，但累计不得超过原票金额。
          红字票沿用原票的客户、票种、税率与关联订单，因此订单净额与统计会自动扣减；红字票本身不可再红冲。
        </Text>
        <Collapse
          size="small" ghost
          items={[{
            key: 'adv', label: '高级：金额拆分 / 备注',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="红字票含税">{fmtCents(-toCents(amountYuan ?? 0))} 元</Descriptions.Item>
                  <Descriptions.Item label="税率（沿用原票）">
                    <Tag>{Number((Number(invoice?.taxRate ?? 0) * 100).toFixed(4))}%</Tag>
                  </Descriptions.Item>
                </Descriptions>
                <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="备注（选填）" />
              </Space>
            ),
          }]}
        />
      </Space>
    </Modal>
  )
}
