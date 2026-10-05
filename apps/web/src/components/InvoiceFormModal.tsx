import { useEffect, useState } from 'react'
import {
  Alert, Checkbox, Col, Collapse, DatePicker, Descriptions, Input, InputNumber, Modal, Row, Select, Space, Typography, message,
} from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { api, loadOptions } from '../lib/api'
import { INVOICE_PLACEHOLDER_PREFIX, INVOICE_TYPE_LABEL, TAX_RATE_OPTIONS } from '../lib/labels'
import { fmtCents, fromCents, splitInclCents, taxCentsOf, toCents } from '../lib/money'
import type { Customer, Invoice, InvoiceType, Order } from '../lib/types'

const { Text } = Typography

/** 快捷开票带入的预填项（订单行「开发票」按钮） */
export interface InvoicePrefill {
  orderIds?: number[]
  customerId?: number
  /** 预填开票金额（含税，分）：快捷开票 = 该订单剩余未开票金额 */
  amountInclCents?: number
  /** 订单由入口带入：仍可见但不可改（避免误关联其他订单） */
  lockOrders?: boolean
}

/**
 * 开票表单弹窗（I16 交互简化版）
 * ------------------------------------------------------------------
 * 简化路径只需三样：**关联订单**（自动带出剩余未开票金额）+ **开票金额（含税）** + 开票日期。
 * 税率默认 0%（不含税 = 含税、税额 = 0），用户不用管税；票种/税率/客户/金额拆分等收进「高级」（默认收起）。
 * 发票号选填：不填由服务端生成占位号「待补号-…」，可随后在编辑里补录真实票号。
 */
export default function InvoiceFormModal({
  open, edit, customers: customersProp, orders: ordersProp, prefill, onClose,
}: {
  open: boolean
  edit: Invoice | null
  /** 可选：父组件已加载的客户/订单（不传则本弹窗自行加载） */
  customers?: Customer[]
  orders?: Order[]
  prefill?: InvoicePrefill | null
  onClose: (reload: boolean) => void
}) {
  const editing = !!edit
  const [customers, setCustomers] = useState<Customer[]>(customersProp ?? [])
  const [orders, setOrders] = useState<Order[]>(ordersProp ?? [])
  const [orderLoading, setOrderLoading] = useState(false)
  const [customerId, setCustomerId] = useState<number>()
  const [orderIds, setOrderIds] = useState<number[]>([])
  const [amountYuan, setAmountYuan] = useState<number | undefined>()
  /** 用户是否手改过金额：改过则不再随订单选择自动覆盖 */
  const [amountTouched, setAmountTouched] = useState(false)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('vat_general')
  const [taxRate, setTaxRate] = useState<number>(0)
  const [issueDate, setIssueDate] = useState<Dayjs | null>(dayjs())
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)
  /** 允许超开（I16 收敛⑤）：默认阻止；只有「高级」显式勾选才放行 */
  const [allowOver, setAllowOver] = useState(false)
  /** 设置页配置的开票默认税率（未配置 = 0） */
  const [defaultTaxRate, setDefaultTaxRate] = useState(0)

  // ---- 打开时初始化（编辑载入 / 新建按带入项预填） ----
  useEffect(() => {
    if (!open) return
    if (edit) {
      setCustomerId(edit.customerId)
      setOrderIds(edit.orderRefs.map((r) => r.orderId))
      setAmountYuan(fromCents(edit.amountInclCents))
      setInvoiceNo(edit.invoiceNo)
      setInvoiceType(edit.invoiceType)
      setTaxRate(Number(edit.taxRate))
      setIssueDate(dayjs(edit.issueDate))
      setRemark(edit.remark ?? '')
      setAmountTouched(true)
    } else {
      setCustomerId(prefill?.customerId)
      setOrderIds(prefill?.orderIds ?? [])
      setAmountYuan(prefill?.amountInclCents != null ? fromCents(prefill.amountInclCents) : undefined)
      setInvoiceNo('')
      setInvoiceType('vat_general')
      setTaxRate(0)
      setIssueDate(dayjs())
      setRemark('')
      setAmountTouched(false)
      setAllowOver(false)
    }
  }, [open, edit]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 开票默认税率（设置页配置；新建时带出，用户仍可不管） ----
  useEffect(() => {
    if (!open) return
    api<{ defaultTaxRate: number }>('/invoices/settings')
      .then((s) => {
        const rate = Number(s.defaultTaxRate ?? 0)
        setDefaultTaxRate(rate)
        if (!edit) setTaxRate(rate)
      })
      .catch(() => { /* 读不到就用 0%，不阻断开票 */ })
  }, [open, edit]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 客户候选 ----
  useEffect(() => {
    if (!open || customersProp) return
    loadOptions<Customer>('/customers', setCustomers, '客户档案')
  }, [open, customersProp])

  // ---- 订单候选（外部传入优先；否则按客户拉取） ----
  useEffect(() => {
    if (!open) return
    if (ordersProp) { setOrders(ordersProp); return }
    if (!customerId) { setOrders([]); return }
    setOrderLoading(true)
    api<Order[]>(`/orders?customerId=${customerId}`)
      .then(setOrders)
      .catch((e) => message.error('关联订单加载失败：' + (e as Error).message))
      .finally(() => setOrderLoading(false))
  }, [open, customerId, ordersProp])

  const selected = orders.filter((o) => orderIds.includes(o.id))
  const remainCents = selected.reduce((s, o) => s + Math.max(0, o.uninvoicedCents ?? 0), 0)

  /**
   * 关联订单变化：自动带出「剩余未开票金额合计」并锁定客户（未手改金额时）。
   * 单订单快捷开票 → 金额即该订单 价格 − 已开票，点确定即结清。
   */
  useEffect(() => {
    if (!open || editing) return
    if (selected.length) {
      setCustomerId((cur) => cur ?? selected[0].customerId)
      if (!amountTouched && remainCents > 0) setAmountYuan(fromCents(remainCents))
    }
  }, [open, editing, orderIds, orders]) // eslint-disable-line react-hooks/exhaustive-deps

  const exclCents = editing ? edit!.amountExclCents : splitInclCents(toCents(amountYuan ?? 0), taxRate).exclCents
  const taxCents = taxCentsOf(exclCents, taxRate)
  const inclCents = editing ? exclCents + taxCents : toCents(amountYuan ?? 0)
  const isPlaceholderNo = editing && edit!.invoiceNo.startsWith(INVOICE_PLACEHOLDER_PREFIX)

  async function submit() {
    if (!customerId) { message.warning('请选择关联订单（或在「高级」里选择客户）'); return }
    if (inclCents <= 0) { message.warning('请填写开票金额（含税，须大于 0）'); return }
    if (!issueDate) { message.warning('请选择开票日期'); return }
    // 超开闸门（默认阻止）：所选订单已开完 / 本次将超出 → 必须到「高级」显式勾选「允许超开」
    if (!editing && selected.length && !allowOver && inclCents > remainCents) {
      message.warning(
        `所选订单未开票余额仅 ${(remainCents / 100).toFixed(2)} 元，本次开票 ${(inclCents / 100).toFixed(2)} 元会超出：`
        + '如确需超开，请在「高级」里勾选「允许超开」',
      )
      return
    }
    if (editing && !isPlaceholderNo && invoiceNo.trim() !== edit!.invoiceNo) {
      message.warning('真实票号不可修改（如需换号请先作废后重开）')
      return
    }
    setSaving(true)
    try {
      const body = editing
        ? {
          ...(isPlaceholderNo && invoiceNo.trim() ? { invoiceNo: invoiceNo.trim() } : {}),
          remark, issueDate: issueDate.format('YYYY-MM-DD'), taxRate, taxCents,
          amountInclCents: exclCents + taxCents, orderIds,
        }
        : {
          ...(invoiceNo.trim() ? { invoiceNo: invoiceNo.trim() } : {}),
          invoiceType, customerId, amountInclCents: inclCents, taxRate,
          issueDate: issueDate.format('YYYY-MM-DD'), orderIds, remark,
          ...(allowOver ? { allowOverInvoiced: true } : {}),
        }
      const res = await api<Invoice>(editing ? `/invoices/${edit!.id}` : '/invoices', { method: editing ? 'PUT' : 'POST', body })
      if (res?.warning) message.warning(res.warning)
      message.success(editing ? '发票已更新' : `发票已登记${res.invoiceNo ? '：' + res.invoiceNo : ''}`)
      onClose(true)
    } catch (e) {
      message.error((e as Error).message)
    } finally { setSaving(false) }
  }

  const advanced = (
    <Space direction="vertical" style={{ width: '100%' }} size={10}>
      <Row gutter={12}>
        <Col span={12}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>发票类型{editing ? '（不可修改）' : ''}</Text>
          <Select style={{ width: '100%' }} value={invoiceType} disabled={editing}
            onChange={(v) => setInvoiceType(v as InvoiceType)}
            options={Object.entries(INVOICE_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Col>
        <Col span={12}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
            税率（默认 {Number(((editing ? Number(edit?.taxRate ?? 0) : defaultTaxRate) * 100).toFixed(4))}%{editing && edit?.isRed ? '，红字票沿用原票不可改' : '，设置页可配'}）
          </Text>
          <Select style={{ width: '100%' }} value={taxRate} disabled={editing && !!edit?.isRed}
            onChange={(v) => setTaxRate(Number(v))} options={TAX_RATE_OPTIONS} />
        </Col>
      </Row>
      <Row gutter={12}>
        <Col span={12}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
            客户{orderIds.length ? '（随关联订单自动带入）' : '（未关联订单时必选）'}
          </Text>
          <Select style={{ width: '100%' }} value={customerId} disabled={editing || orderIds.length > 0} showSearch optionFilterProp="label"
            placeholder="选择客户" onChange={(v) => { setCustomerId(v); if (!ordersProp) setOrderIds([]) }}
            options={customers.map((c) => ({ value: c.id, label: c.name }))} />
        </Col>
        <Col span={12}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>金额拆分（自动，只读）</Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="不含税">{fmtCents(exclCents)} 元</Descriptions.Item>
            <Descriptions.Item label="税额">{fmtCents(taxCents)} 元</Descriptions.Item>
          </Descriptions>
        </Col>
      </Row>
      {editing && isPlaceholderNo && (
        <Alert type="info" showIcon message="当前为占位票号（待补号-…）：拿到真实发票号后可在此补录，无需作废重开。" />
      )}
      {!editing && (
        <div>
          <Checkbox checked={allowOver} onChange={(e) => setAllowOver(e.target.checked)}>
            允许超开（订单已开完时仍继续开票；默认阻止）
          </Checkbox>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            不勾选时：所选订单未开票余额不足会被拒绝（中文提示）；勾选后放行，仅在返回里给 warning 说明超出金额。
          </Text>
        </div>
      )}
    </Space>
  )

  return (
    <Modal
      title={editing ? `编辑开票 ${edit?.invoiceNo}` : '开票'}
      open={open} onCancel={() => onClose(false)} onOk={submit} confirmLoading={saving}
      okText={editing ? '保存' : '确定开票'} width={640}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
            关联订单（可多选；选中后自动带出「价格 − 已开票」的未开票金额）
          </Text>
          <Select
            mode="multiple" style={{ width: '100%' }} value={orderIds} loading={orderLoading}
            disabled={prefill?.lockOrders && !editing}
            showSearch optionFilterProp="label" allowClear placeholder="选择订单（可留空 = 不挂单开票）"
            onChange={(v) => { setOrderIds(v as number[]); setAmountTouched(false) }}
            notFoundContent={customerId ? '该客户暂无订单' : '请先选择客户'}
            options={orders.map((o) => ({
              value: o.id,
              label: `${o.orderNo} · 未开票 ${fmtCents(Math.max(0, o.uninvoicedCents ?? 0))} 元`,
            }))}
          />
          {!!selected.length && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              所选订单未开票合计 {fmtCents(remainCents)} 元
              {remainCents === 0 ? '（已开完，继续开票会超额但不会被阻断）' : ''}
            </Text>
          )}
        </div>

        <Row gutter={12}>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
              开票金额（含税，元）*{editing ? '（不可改，需作废重开）' : ''}
            </Text>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} value={amountYuan} disabled={editing}
              onChange={(v) => { setAmountYuan((v as number) ?? undefined); setAmountTouched(true) }} placeholder="如 10000.00" />
          </Col>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>开票日期 *</Text>
            <DatePicker style={{ width: '100%' }} value={issueDate} onChange={(v) => setIssueDate(v)} />
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>发票号（可选）</Text>
            <Input value={invoiceNo} disabled={editing && !isPlaceholderNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder={editing ? '' : '不填则自动生成待补号'} />
          </Col>
          <Col span={12}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>备注（可选）</Text>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="选填" />
          </Col>
        </Row>

        <Text type="secondary" style={{ fontSize: 12 }}>
          合计含税 <Text strong>{fmtCents(inclCents)}</Text> 元
          {taxRate === 0 ? '（税率默认 0%：不含税 = 含税、税额 = 0）' : `（含税 = 不含税 + 税额，税额按 ${Number((taxRate * 100).toFixed(4))}% 计算）`}
        </Text>

        <Collapse
          size="small" ghost
          items={[{ key: 'adv', label: '高级（票种 / 税率 / 客户 / 金额拆分）', children: advanced }]}
        />
      </Space>
    </Modal>
  )
}
