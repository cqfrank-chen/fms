import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Select, Space, Tag, Typography, message } from 'antd'
import { api } from '../lib/api'
import { DEFAULT_TAX_RATE_OPTIONS } from '../lib/labels'
import type { InvoiceSettings } from '../lib/types'

const { Text } = Typography

/**
 * 开票设置（I16 收敛②）：开票默认税率。
 * 极简实现：复用既有 app_settings（key = invoice.default_tax_rate），不引入配置框架。
 * 开票弹窗会自动带出该税率；用户仍可不管（默认 0% = 不含税=含税、税额 0）。
 */
export default function InvoiceSettingsCard() {
  const [rate, setRate] = useState<number>(0)
  const [saved, setSaved] = useState<number>(0)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await api<InvoiceSettings>('/invoices/settings')
      setRate(Number(s.defaultTaxRate ?? 0))
      setSaved(Number(s.defaultTaxRate ?? 0))
    } catch (e) {
      message.error('开票设置加载失败：' + (e as Error).message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    try {
      const s = await api<InvoiceSettings>('/invoices/settings', { method: 'PUT', body: { defaultTaxRate: rate } })
      setSaved(Number(s.defaultTaxRate ?? 0))
      message.success('开票默认税率已保存（开票弹窗下次打开即带出）')
    } catch (e) {
      message.error((e as Error).message)
    } finally { setSaving(false) }
  }

  return (
    <Card
      size="small" title="开票默认税率（账务 · 开票）"
      extra={<Text type="secondary" style={{ fontSize: 12 }}>仅影响新建开票的默认值；可在开票弹窗「高级」里逐张调整</Text>}
    >
      <Space wrap>
        <Select style={{ width: 240 }} value={rate} onChange={(v) => setRate(Number(v))} options={DEFAULT_TAX_RATE_OPTIONS} />
        <Button type="primary" loading={saving} onClick={save} disabled={rate === saved}>保存</Button>
        {saved !== 0 && <Tag color="blue">当前默认 {Number((saved * 100).toFixed(4))}%</Tag>}
      </Space>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          默认 0%：不含税金额 = 含税金额、税额 = 0（客户「不要做的太复杂」的口径）；需要专票时再在开票弹窗「高级」里选 13%/9%/6%/1%。
        </Text>
      </div>
    </Card>
  )
}
