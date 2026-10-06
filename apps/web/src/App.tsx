import { useEffect, useMemo, useState } from 'react'
import { Badge, Layout, Menu, Space, Typography } from 'antd'
import {
  AccountBookOutlined, AppstoreOutlined, DashboardOutlined, DatabaseOutlined, FileImageOutlined,
  ProfileOutlined, RobotOutlined, ScheduleOutlined, SettingOutlined, ShoppingCartOutlined, TagOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { ReactNode } from 'react'
import AlertBell from './components/AlertBell'
import Forbidden from './components/Forbidden'
import OperatorPicker from './components/OperatorPicker'
import UserMenu from './components/UserMenu'
import AccountingPage from './pages/AccountingPage'
import AiPage from './pages/AiPage'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import OrdersPage from './pages/OrdersPage'
import PlansPage from './pages/PlansPage'
import QuotesPage from './pages/QuotesPage'
import SchedulingPage from './pages/SchedulingPage'
import StickersPage from './pages/StickersPage'
import SetupPage from './pages/SetupPage'
import WarehousePage from './pages/WarehousePage'
import { canAccessPage, defaultPage, fetchMe } from './lib/auth'
import type { AuthUser } from './lib/auth'
import { LOGIN_PATH, usePathname, navigate } from './lib/router'
import { getToken, getUser } from './lib/token'
import type { PageKey } from './lib/nav'

interface HealthInfo { status: string; db: string; time: string }

const API = '/api'
const { Header, Content, Sider } = Layout

/** 侧栏菜单定义（顺序即展示顺序）；「设置」单独放分隔线之后，仅 admin 可见 */
const MENU_DEF: { key: PageKey; icon: ReactNode; label: string }[] = [
  { key: 'overview', icon: <DashboardOutlined />, label: '首页概览' },
  { key: 'orders', icon: <ShoppingCartOutlined />, label: '订单管理' },
  { key: 'plans', icon: <ProfileOutlined />, label: '计划单' },
  { key: 'schedule', icon: <ScheduleOutlined />, label: '排程看板' },
  { key: 'warehouse', icon: <DatabaseOutlined />, label: '仓储管理' },
  { key: 'stickers', icon: <FileImageOutlined />, label: '不干胶库存' },
  { key: 'accounting', icon: <AccountBookOutlined />, label: '账目统计' },
  { key: 'quotes', icon: <TagOutlined />, label: '报价记录' },
  { key: 'ai', icon: <RobotOutlined />, label: 'AI 助手' },
]
const SETUP_MENU = { key: 'setup' as PageKey, icon: <SettingOutlined />, label: '设置 · 主数据' }

/** 页面中文名（403 提示用） */
const PAGE_TITLE: Record<PageKey, string> = {
  overview: '首页概览',
  orders: '订单管理',
  plans: '计划单',
  schedule: '排程看板',
  warehouse: '仓储管理',
  stickers: '不干胶库存',
  accounting: '账目统计',
  quotes: '报价记录',
  ai: 'AI 助手',
  setup: '设置 · 主数据',
}

/**
 * 应用外壳：登录守卫 → 顶栏（品牌 + 操作人 + 当前用户 + 预警 + 状态）+ 侧栏导航（按角色过滤）+ 页面内容。
 * 未登录访问任何路径 → /login；已登录访问 /login → /；越权页面 → 403 提示页。
 */
export default function App() {
  const path = usePathname()
  const [user, setUser] = useState<AuthUser | null>(() => (getToken() ? getUser() : null))
  const [page, setPage] = useState<PageKey>(() => {
    const u = getToken() ? getUser() : null
    return u ? defaultPage(u.role) : 'overview'
  })
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const authed = !!getToken() && !!user

  // 路由守卫：未登录 → /login；已登录访问 /login → 首页
  useEffect(() => {
    if (!getToken() && path !== LOGIN_PATH) navigate(LOGIN_PATH, true)
    else if (getToken() && path === LOGIN_PATH) navigate('/', true)
  }, [path, user])

  // 已登录时用 /auth/me 回查（后端每次回库：改角色/停用即时生效；401 由 api.ts 统一登出跳转）
  useEffect(() => {
    if (!authed) return
    let alive = true
    fetchMe()
      .then((u) => { if (alive) setUser(u) })
      .catch(() => { if (alive) setUser(null) })
    return () => { alive = false }
  }, [authed, path])

  // 系统状态轮询（/api/health 免登录；登录页不轮询）
  useEffect(() => {
    if (!authed) { setHealth(null); return }
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(API + '/health')
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const json = (await res.json()) as HealthInfo
        if (alive) setHealth(json)
      } catch {
        if (alive) setHealth(null)
      }
    }
    tick()
    const timer = window.setInterval(tick, 30000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [authed])

  // 菜单：按角色过滤（PAGE_ROLES 见 lib/auth.ts）
  const menuItems = useMemo<MenuProps['items']>(() => {
    if (!user) return []
    const items: NonNullable<MenuProps['items']> = MENU_DEF
      .filter((m) => canAccessPage(user.role, m.key))
      .map((m) => ({ key: m.key, icon: m.icon, label: m.label }))
    if (canAccessPage(user.role, 'setup')) {
      items.push({ type: 'divider' })
      items.push({ key: SETUP_MENU.key, icon: SETUP_MENU.icon, label: SETUP_MENU.label })
    }
    return items
  }, [user])

  const onLogin = (u: AuthUser) => {
    setUser(u)
    setPage(defaultPage(u.role))
    navigate('/', true)
  }

  // 登录页（或未登录时的占位：守卫 effect 会把地址替换成 /login）
  if (path === LOGIN_PATH || !authed || !user) {
    return <LoginPage onSuccess={onLogin} />
  }

  const online = health?.status === 'ok' && health?.db === 'up'
  const allowed = canAccessPage(user.role, page)

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
          <UserMenu user={user} />
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
            selectedKeys={allowed ? [page] : []}
            items={menuItems}
            style={{ height: '100%', borderRight: 0, paddingTop: 8 }}
            onClick={({ key }) => setPage(key as PageKey)}
          />
        </Sider>
        {/* minWidth: 0：Content 是 flex 子项，默认 min-width:auto 会被内部宽表格顶开，导致整页横向滚动 */}
        <Content style={{ padding: 20, background: '#f0f2f5', minWidth: 0 }}>
          {!allowed ? (
            <Forbidden title={PAGE_TITLE[page]} />
          ) : (
            <>
              {page === 'overview' && <DashboardPage onNavigate={setPage} />}
              {page === 'orders' && <OrdersPage />}
              {page === 'plans' && <PlansPage />}
              {page === 'schedule' && <SchedulingPage />}
              {page === 'warehouse' && <WarehousePage />}
              {page === 'stickers' && <StickersPage />}
              {page === 'accounting' && <AccountingPage />}
              {page === 'quotes' && <QuotesPage />}
              {page === 'ai' && <AiPage />}
              {page === 'setup' && <SetupPage />}
            </>
          )}
        </Content>
      </Layout>
    </Layout>
  )
}
