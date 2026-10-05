import { useState } from 'react'
import { Space, Typography } from 'antd'
import StickerImportCard from '../components/StickerImportCard'
import StickersPanel from '../components/StickersPanel'

/**
 * 不干胶库存页（I18）
 * ------------------------------------------------------------------
 * 页面结构：上传识别建档（不写库 → 人工确认 → 建档）+ 库存列表（筛选 / 缩略图 / 大图 / 就地入库领用）。
 * 识图不可用时（Key 未配置或调用失败）页面给出中文提示并允许手工填写后直接建档。
 */
export default function StickersPage() {
  const [tick, setTick] = useState(0)
  const bump = () => setTick((v) => v + 1)
  return (
    <div style={{ maxWidth: 1400 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>不干胶库存</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        上传不干胶图片 → 识别提取（品牌 / 样式 / 规格 / 数量）→ 生成库存标题与备注 → 建档；
        图片存挂载卷、库里只存路径，识别原文一并留痕便于人工复核。识图不可用时可直接手工填写建档，缺项会写进备注。
      </Typography.Paragraph>
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <StickerImportCard onCreated={bump} />
        <StickersPanel key={tick} onChanged={bump} />
      </Space>
    </div>
  )
}
