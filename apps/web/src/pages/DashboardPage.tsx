import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Col, Empty, List, Row, Spin, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AccountBookOutlined, AppstoreOutlined, AuditOutlined, BarChartOutlined, ClockCircleOutlined,
  DatabaseOutlined, InboxOutlined, MoneyCollectOutlined, PayCircleOutlined, ProfileOutlined,
  ReloadOutlined, RiseOutlined, RobotOutlined, ScheduleOutlined, ShoppingCartOutlined,
  ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { api } from '../lib/api'
import { STATUS_LABEL } from '../lib/labels'
import type { PageKey } from '../lib/nav'

const { Text, Title } = Typography

interface DashboardData {
  kpi: {
    ordersActive: number; ordersDraft: number; ordersCompleted: number
    plansPendingAudit: number; plansInProduction: number; plansActive: number
    receiptsDraft: number; outboundsPendingOqc: number; outboundsDraft: number
    lowStockCount: number
    receivableOutstanding: number; overdueCount: number; overdueAmount: number
    payableOutstanding: number
    month: string; monthRevenue: number; monthProfit: number
    monthMaterial: number; monthManufactureCost: number
  }
  todo: Array<{ level: 'warn' | 'info'; text: string; page: PageKey }>
  lowStock: Array<{ id: number; name: string; safetyStock: number; stock: number; gap: number }>
  recentOrders: Array<{ id: number; orderNo: string; poNo: string | null; status: string; dueDate: string; customerName: string; totalAmount: number }>
  overdueTop: Array<{ id: number; recvNo: string; customerName: string; orderNo: string; remain: number; ageDays: number; dueDate: string }>
  generatedAt: string
}

const money = (n: number | undefined | null) =>
  '¥' + (n ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const moneyShort = (n: number | undefined | null) => {
  const v = n ?? 0
  if (Math.abs(v) >= 10000) return '¥' + (v / 10000).toFixed(2) + ' 万'
  return money(v)
}
const dateText = (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : '—')
const statusColor = (s: string) =>
  ({ draft: 'default', confirmed: 'blue', production: 'processing', completed: 'success', cancelled: 'default', voided: 'default' } as Record<string, string>)[s] ?? 'default'

function KpiCard({ icon, color, title, value, hint, onClick }: {
  icon: React.ReactNode; color: string; title: string; value: React.ReactNode; hint?: string; onClick?: () => void
}) {
  return (
    <Card size="small" hoverable={!!onClick} onClick={onClick} styles={{ body: { padding: '16px 18px' } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 46, height: 46, borderRadius: 12, background: color + '14',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
        }}>
          <span style={{ color, fontSize: 22 }}>{icon}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: '#5f6368' }}>{title}</div>
          <div style={{ fontSize: 23, fontWeight: 600, lineHeight: 1.3, whiteSpace: 'nowrap' }}>{value}</div>
        </div>
      </div>
      {hint && <div style={{ marginTop: 10, fontSize: 12, color: '#8c8c8c' }}>{hint}</div>}
    </Card>
  )
}

/** 首页概览：关键数据、待办提示与快捷入口（只读看板） */
export default function DashboardPage({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api<DashboardData>('/dashboard'))
    } catch (e) {
      message.error('看板数据加载失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  if (loading && !data) {
    return <Card size="small" style={{ textAlign: 'center', padding: 48 }}><Spin /><div style={{ marginTop: 12, color: '#8c8c8c' }}>正在加载看板数据…</div></Card>
  }
  const k = data?.kpi
  const orderColumns: ColumnsType<DashboardData['recentOrders'][number]> = [
    { title: '订单号', dataIndex: 'orderNo', width: 150 },
    {
      // 客户 PO 号紧贴订单号，与**订单列表同一口径**（甲方 2026-10-06：PO 号要完整显示）：
      // 不用省略号截断、不靠 Tooltip 看全文 —— 长 PO 号走换行（wordBreak 兜底防撑破列），空值显示「—」。
      title: 'PO号', dataIndex: 'poNo', width: 180,
      render: (v?: string | null) => (v
        ? <span style={{ whiteSpace: 'normal', wordBreak: 'break-all', lineHeight: 1.35 }}>{v}</span>
        : <Text type="secondary">—</Text>),
    },
    { title: '客户', dataIndex: 'customerName', ellipsis: true },
    { title: '交期', dataIndex: 'dueDate', width: 110, render: (v: string) => dateText(v) },
    { title: '金额', dataIndex: 'totalAmount', width: 130, align: 'right', render: (v: number) => money(v) },
    { title: '状态', dataIndex: 'status', width: 92, render: (v: string) => <Tag color={statusColor(v)}>{STATUS_LABEL[v] ?? v}</Tag> },
  ]

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <Card size="small" style={{ marginBottom: 16, background: 'linear-gradient(135deg,#0f2540,#1d4e79)', border: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <AppstoreOutlined style={{ fontSize: 30, color: '#69b1ff' }} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <Title level={4} style={{ color: '#fff', margin: 0 }}>生产运营概览</Title>
            <Text style={{ color: 'rgba(255,255,255,.72)', fontSize: 13 }}>
              订单 · 计划 · 排程 · 仓储 · 账目 一屏总览
            </Text>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: 'rgba(255,255,255,.72)', fontSize: 12 }}>
              数据时间 {data ? dayjs(data.generatedAt).format('YYYY-MM-DD HH:mm:ss') : '—'}
            </div>
            <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={load} style={{ color: '#d6e8ff' }}>
              刷新
            </Button>
          </div>
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<ShoppingCartOutlined />} color="#1677ff" title="进行中订单"
            value={k?.ordersActive ?? 0}
            hint={`草稿 ${k?.ordersDraft ?? 0} · 已完成 ${k?.ordersCompleted ?? 0}`}
            onClick={() => onNavigate('orders')} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<ProfileOutlined />} color="#722ed1" title="在制计划单"
            value={k?.plansActive ?? 0}
            hint={`待审核 ${k?.plansPendingAudit ?? 0} · 生产中 ${k?.plansInProduction ?? 0}`}
            onClick={() => onNavigate('plans')} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<InboxOutlined />} color="#13c2c2" title="待确认入库"
            value={k?.receiptsDraft ?? 0}
            hint={`待 OQC 出库 ${k?.outboundsPendingOqc ?? 0} 张`}
            onClick={() => onNavigate('warehouse')} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<WarningOutlined />} color="#fa541c" title="低库存预警"
            value={k?.lowStockCount ?? 0}
            hint="低于产品安全库存"
            onClick={() => onNavigate('warehouse')} />
        </Col>

        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<MoneyCollectOutlined />} color="#faad14" title="应收未收"
            value={moneyShort(k?.receivableOutstanding)}
            hint={`逾期 ${k?.overdueCount ?? 0} 笔 · ${moneyShort(k?.overdueAmount)}`}
            onClick={() => onNavigate('accounting')} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<RiseOutlined />} color="#52c41a" title={`本月营收（${k?.month ?? ''}）`}
            value={moneyShort(k?.monthRevenue)}
            hint={`本月利润 ${moneyShort(k?.monthProfit)}`}
            onClick={() => onNavigate('accounting')} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<BarChartOutlined />} color="#2f54eb" title="本月成本"
            value={moneyShort((k?.monthMaterial ?? 0) + (k?.monthManufactureCost ?? 0))}
            hint={`材料 ${moneyShort(k?.monthMaterial)} · 制费 ${moneyShort(k?.monthManufactureCost)}`}
            onClick={() => onNavigate('accounting')} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <KpiCard icon={<PayCircleOutlined />} color="#eb2f96" title="应付未付"
            value={moneyShort(k?.payableOutstanding)}
            hint="供应商往来余额"
            onClick={() => onNavigate('accounting')} />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={16}>
          <Card size="small" title={<><ThunderboltOutlined style={{ color: '#faad14', marginRight: 6 }} />待办提示</>}
            extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {data?.todo.length ?? 0} 项</Text>}
            styles={{ body: { paddingTop: 8 } }}>
            <List
              size="small"
              dataSource={data?.todo ?? []}
              renderItem={(t) => (
                <List.Item
                  actions={[<Button key="go" type="link" size="small" onClick={() => onNavigate(t.page)}>前往处理</Button>]}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {t.level === 'warn'
                      ? <WarningOutlined style={{ color: '#fa541c' }} />
                      : <ClockCircleOutlined style={{ color: '#8c8c8c' }} />}
                    <span>{t.text}</span>
                  </span>
                </List.Item>
              )}
            />
          </Card>

          <Card size="small" style={{ marginTop: 16 }}
            title={<><ShoppingCartOutlined style={{ color: '#1677ff', marginRight: 6 }} />最近订单</>}
            extra={<Button type="link" size="small" onClick={() => onNavigate('orders')}>查看全部</Button>}
            styles={{ body: { padding: 0 } }}>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              columns={orderColumns}
              scroll={{ x: 840 }}
              dataSource={data?.recentOrders ?? []}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无订单" /> }}
            />
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card size="small" title={<><MoneyCollectOutlined style={{ color: '#faad14', marginRight: 6 }} />应收提醒</>}
            extra={<Button type="link" size="small" onClick={() => onNavigate('accounting')}>对账单</Button>}
            styles={{ body: { paddingTop: 8 } }}>
            {(data?.overdueTop?.length ?? 0) === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无逾期应收" />
              : <List
                  size="small"
                  dataSource={data?.overdueTop ?? []}
                  renderItem={(r) => (
                    <List.Item>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>{r.customerName}</div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{r.recvNo} · {r.orderNo || '—'}</Text>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ color: '#cf1322', fontWeight: 600 }}>{money(r.remain)}</div>
                        <Text type="secondary" style={{ fontSize: 12 }}>逾期 {r.ageDays} 天</Text>
                      </div>
                    </List.Item>
                  )}
                />}
          </Card>

          <Card size="small" style={{ marginTop: 16 }}
            title={<><WarningOutlined style={{ color: '#fa541c', marginRight: 6 }} />低库存产品</>}
            styles={{ body: { paddingTop: 8 } }}>
            {(data?.lowStock?.length ?? 0) === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="库存均高于安全线" />
              : <List
                  size="small"
                  dataSource={data?.lowStock ?? []}
                  renderItem={(p) => (
                    <List.Item>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <Text type="danger">库存 {p.stock} / 安全 {p.safetyStock}</Text>
                    </List.Item>
                  )}
                />}
          </Card>

          <Card size="small" style={{ marginTop: 16 }} title={<><AuditOutlined style={{ color: '#52c41a', marginRight: 6 }} />快捷操作</>}>
            <Row gutter={[8, 8]}>
              <Col span={12}><Button block icon={<ShoppingCartOutlined />} onClick={() => onNavigate('orders')}>订单管理</Button></Col>
              <Col span={12}><Button block icon={<ProfileOutlined />} onClick={() => onNavigate('plans')}>计划单审核</Button></Col>
              <Col span={12}><Button block icon={<ScheduleOutlined />} onClick={() => onNavigate('schedule')}>排程看板</Button></Col>
              <Col span={12}><Button block icon={<DatabaseOutlined />} onClick={() => onNavigate('warehouse')}>仓储管理</Button></Col>
              <Col span={12}><Button block icon={<AccountBookOutlined />} onClick={() => onNavigate('accounting')}>账目统计</Button></Col>
              <Col span={12}><Button block icon={<RobotOutlined />} onClick={() => onNavigate('ai')}>AI 助手</Button></Col>
            </Row>
          </Card>

          <Card size="small" style={{ marginTop: 16 }} title="使用提示">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#5f6368', lineHeight: 1.9 }}>
              <li>订单「确认」后自动生成计划单，计划单审核通过才进入排程池</li>
              <li>出库需先过 OQC（待检不可出库）；入库草稿须仓管确认后才增加库存</li>
              <li>收款核销即确认营收；每月填一次六类成本，利润视图才完整</li>
              <li>数据安全：每日执行 <Text code>backup.bat</Text>，每周拷贝到移动硬盘</li>
            </ul>
          </Card>
        </Col>
      </Row>
      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>工厂生产管理系统 · 单机部署，数据仅保存在本厂服务器</Text>
      </div>
    </div>
  )
}
