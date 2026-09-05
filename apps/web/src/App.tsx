import { useEffect, useState } from 'react'
import { Badge, Button, Card, Col, Descriptions, Form, Input, Layout, Menu, Modal, Row, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { MenuProps } from 'antd'
import SetupPage from './pages/SetupPage'
import OrdersPage from './pages/OrdersPage'
import PlansPage from './pages/PlansPage'
import SchedulingPage from './pages/SchedulingPage'
import WarehousePage from './pages/WarehousePage'
import AccountingPage from './pages/AccountingPage'

interface HealthInfo { status: string; db: string; time: string }
interface TestProduct {
  id: number
  name: string
  sku: string
  note?: string
  createdAt: string
}

const API = '/api'
const { Header, Content, Sider } = Layout

type PageKey = 'overview' | 'orders' | 'plans' | 'schedule' | 'warehouse' | 'accounting' | 'setup'

const MENU_ITEMS: MenuProps['items'] = [
  { key: 'overview', label: '首页' },
  { key: 'orders', label: '订单' },
  { key: 'plans', label: '计划单' },
  { key: 'schedule', label: '排程' },
  { key: 'warehouse', label: '仓储' },
  { key: 'accounting', label: '账目' },
  { type: 'divider' },
  { key: 'setup', label: '设置 · 主数据' },
]

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

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 16, paddingInline: 24 }}>
        <Typography.Title level={4} style={{ color: '#fff', margin: 0, flex: 1 }}>
          工厂管理系统 FMS
        </Typography.Title>
        <Space>
          {health ? (
            <Badge status={health.status === 'ok' ? 'success' : 'warning'} text={
              <span style={{ color: '#fff' }}>API {health.status} · 数据库 {health.db}</span>
            } />
          ) : (
            <Badge status="error" text={<span style={{ color: '#fff' }}>API 不可达</span>} />
          )}
        </Space>
      </Header>
      <Layout>
        <Sider width={170} theme="light">
          <Menu
            mode="inline"
            selectedKeys={[page]}
            items={MENU_ITEMS}
            style={{ height: '100%', borderRight: 0 }}
            onClick={({ key }) => setPage(key as PageKey)}
          />
        </Sider>
        <Content style={{ padding: 24, background: '#f5f5f5' }}>
          {page === 'overview' && <OverviewPage />}
          {page === 'orders' && <OrdersPage />}
          {page === 'setup' && <SetupPage />}
          {page === 'plans' && <PlansPage />}
          {page === 'schedule' && <SchedulingPage />}
          {page === 'warehouse' && <WarehousePage />}
          {page === 'accounting' && <AccountingPage />}
        </Content>
      </Layout>
    </Layout>
  )
}

function OverviewPage() {
  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <AlertStrip />
      </Col>
      <Col span={24}>
        <CrudDemoCard />
      </Col>
    </Row>
  )
}

function AlertStrip() {
  return (
    <Card size="small">
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text strong>实施进度</Typography.Text>
        <Space wrap>
          {[
            { label: 'I01 技术验证', done: true },
            { label: 'I02 地基', done: true },
            { label: 'I03 主数据', done: true },
            { label: 'I04 订单', done: true },
            { label: 'I05 计划单', done: true },
            { label: 'I06 报工', done: true },
            { label: 'I07 反查', done: true },
            { label: 'I08 仓储', done: true },
            { label: 'I09 账目', done: true },
            { label: 'I10 甘特验证', done: true },
            { label: 'I11 排程', done: true },
            { label: 'I12 AI 一期', done: false },
          ].map((t) => (
            <Tag key={t.label} color={t.done ? 'success' : 'default'}>{t.label}</Tag>
          ))}
        </Space>
        <Typography.Text type="secondary">
          阶段 ④ 排期 AI 线：I10 甘特库选型完成（自研 React 泳道甘特，跳出 frappe/dhtmlx 任务树模型）、I11 排程看板落地（待排区+6泳道+贪心分层+拖拽改开始日+超期红框+报工驱动色标）。
        </Typography.Text>
      </Space>
    </Card>
  )
}

/** I01 技术验证遗留：最小全栈 CRUD 演示（正式业务上线后可下线） */
function CrudDemoCard() {
  const [items, setItems] = useState<TestProduct[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestProduct | null>(null)
  const [form] = Form.useForm()

  async function fetchList() {
    setLoading(true)
    try {
      const res = await fetch(`${API}/test-products`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setItems(await res.json())
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchList() }, [])

  function openCreate() { setEditing(null); form.resetFields(); setModalOpen(true) }
  function openEdit(record: TestProduct) { setEditing(record); form.setFieldsValue(record); setModalOpen(true) }

  async function handleSubmit() {
    const values = await form.validateFields()
    try {
      const res = await fetch(`${API}/test-products${editing ? '/' + editing.id : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      message.success(editing ? '已更新' : '已新增')
      setModalOpen(false)
      fetchList()
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    }
  }

  async function handleDelete(record: TestProduct) {
    try {
      const res = await fetch(`${API}/test-products/${record.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      message.success('已删除')
      fetchList()
    } catch (e) {
      message.error('删除失败：' + (e as Error).message)
    }
  }

  const columns: ColumnsType<TestProduct> = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name' },
    { title: 'SKU', dataIndex: 'sku' },
    { title: '备注', dataIndex: 'note' },
    { title: '创建时间', dataIndex: 'createdAt', width: 200 },
    {
      title: '操作', width: 140,
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openEdit(record)}>编辑</Button>
          <Button size="small" danger onClick={() => handleDelete(record)}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="I01 技术验证 · 最小全栈 CRUD"
      extra={<Space><Button type="primary" onClick={openCreate}>+ 新增</Button><Button onClick={fetchList}>刷新</Button></Space>}
    >
      <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="状态">全链路 CRUD 验证载体（React19+AntD6 → NestJS11 → PG18+Drizzle）</Descriptions.Item>
        <Descriptions.Item label="说明">正式业务表已建（设置页），此演示待 I07 阶段②验收后下线</Descriptions.Item>
      </Descriptions>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={items} />
      <Modal title={editing ? '编辑' : '新增'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder={'如：ANM 1/32" 乙炔'} />
          </Form.Item>
          <Form.Item name="sku" label="SKU" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="如：ANM-0032" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
