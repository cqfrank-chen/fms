import { useState } from 'react'
import { Space, Typography } from 'antd'
import QuotesPanel, { QuoteImportCard, QuoteLookupCard } from '../components/QuotesPanel'

/**
 * 报价记录页（I17）：报价单是**独立单据**（不进订单五态），核心诉求是「方便更新」。
 * 页面结构：报价列表（可筛选/改价/停用启用）+ 取价试算 + 批量导入。
 * 与识单联动：识单时缺 unitPrice 的行会按本页维护的报价自动补价（见「AI 导入」的诊断与 notes）。
 */
export default function QuotesPage() {
  const [tick, setTick] = useState(0)
  const bump = () => setTick((v) => v + 1)
  return (
    <div style={{ maxWidth: 1400 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>报价记录</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        独立单据「报价单」：价格会变 → 就地改价即留痕；同「客户+产品」按有效期生效，历史价保留可查。
        识单遇到缺单价的行会按这里的报价自动补价（来源可追溯 priceFrom=quote），未命中则标记待补。
      </Typography.Paragraph>
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <QuotesPanel key={tick} onChanged={bump} />
        <QuoteLookupCard />
        <QuoteImportCard onDone={bump} />
      </Space>
    </div>
  )
}
