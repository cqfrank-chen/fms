import { useEffect, useState } from 'react'
import { Badge, Layout, Menu, Space, Typography } from 'antd'
import {
  AccountBookOutlined, AppstoreOutlined, DashboardOutlined, DatabaseOutlined, ProfileOutlined,
  RobotOutlined, ScheduleOutlined, SettingOutlined, ShoppingCartOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import AlertBell from './components/AlertBell'
import OperatorPicker from './components/OperatorPicker'
import AccountingPage from './pages/AccountingPage'
import AiPage from './pages/AiPage'
import DashboardPage from './pages/DashboardPage'
import OrdersPage from './pages/OrdersPage'
import PlansPage from './pages/PlansPage'
import SchedulingPage from './pages/SchedulingPage'
import SetupPage from './pages/SetupPage'
import WarehousePage from './pages/WarehousePage'
import type { PageKey } from './lib/nav'

interface HealthInfo { status: string; db: string; time: string }

const API = '/api'
const { Header, Content, Sider } = Layout

const MENU_ITEMS: MenuProps['items'] = [
  { key: 'overview', icon: <DashboardOutlined />, label: '首页概览' },
  { key: 'orders', icon: <ShoppingCartOutlined />, label: '订单管理' },
  { key: 'plans', icon: <ProfileOutlined />, label: '计划单' },
  { key: 'schedule', icon: <ScheduleOutlined />, label: '排程看板' },
  { key: 'warehouse', icon: <DatabaseOutlined />, label: '仓储管理' },
  { key: 'accounting', icon: <AccountBookOutlined />, label: '账目统计' },
  { key: 'ai', icon: <RobotOutlined />, label: 'AI 助手' },
  { type: 'divider' },
  { key: 'setup', icon: <SettingOutlined />, label: '设置 · 主数据' },
]

/** 应用外壳：顶栏（品牌 + 预警 + 状态）+ 侧栏导航 + 页面内容 */
export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [page, setPage] = useState<PageKey>('overview')

  async function fetchHealth() {
    try {
      const res = await fetch(`${API}/health`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setHealth(await res.json())
    } catch {
      setHealth(null)
    }
  }
  useEffect(() => {
    fetchHealth()
    const t = setInterval(fetchHealth, 30000)
    return () => clearInterval(t)
  }, [])

  const online = health?.status === 'ok' && health?.db === 'up'
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 14, paddingInline: 22, background: '#0f2540' }}>
        <AppstoreOutlined style={{ fontSize: 24, color: '#69b1ff' }} />
        <div style={{ flex: 1, lineHeight: 1.25 }}>
          <Typography.Title level={5} style={{ color: '#fff', margin: 0, letterSpacing: 0.5 }}>
            工厂生产管理系统
          </Typography.Title>
          <Typography.Text style={{ color: 'rgba(255,255,255,.6)', fontSize: 12 }}>
            订单 · 计划单 · 排程 · 仓储 · 账目 · AI
          </Typography.Text>
        </div>
        <Space size={16}>
          <OperatorPicker />
          <AlertBell />
          <Badge
            status={online ? 'success' : 'error'}
            text={
              <span style={{ color: 'rgba(255,255,255,.85)', fontSize: 12 }}>
                {online ? '系统正常' : health ? '数据库异常' : '服务未连接'}
              </span>
            }
          />
        </Space>
      </Header>
      <Layout>
        <Sider width={190} theme="light" style={{ borderRight: '1px solid #eaeef2' }}>
          <Menu
            mode="inline"
            selectedKeys={[page]}
            items={MENU_ITEMS}
            style={{ height: '100%', borderRight: 0, paddingTop: 8 }}
            onClick={({ key }) => setPage(key as PageKey)}
          />
        </Sider>
        <Content style={{ padding: 20, background: '#f0f2f5' }}>
          {page === 'overview' && <DashboardPage onNavigate={setPage} />}
          {page === 'orders' && <OrdersPage />}
          {page === 'plans' && <PlansPage />}
          {page === 'schedule' && <SchedulingPage />}
          {page === 'warehouse' && <WarehousePage />}
          {page === 'accounting' && <AccountingPage />}
          {page === 'ai' && <AiPage />}
          {page === 'setup' && <SetupPage />}
        </Content>
      </Layout>
    </Layout>
  )
}
