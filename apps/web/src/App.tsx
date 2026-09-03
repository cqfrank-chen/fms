import { useEffect, useState } from 'react'
import {
  Alert, Badge, Button, Card, Col, Descriptions, Form, Input, Layout, Modal, Row, Space,
  Table, Tag, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'

interface HealthInfo { status: string; db: string; time: string }
interface TestProduct {
  id: number
  name: string
  sku: string
  note?: string
  createdAt: string
}

const API = '/api'
const { Header, Content } = Layout

export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null)

  // ---- 健康检查（I02：首页可访问验收点）----
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
      <Header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Typography.Title level={4} style={{ color: '#fff', margin: 0, flex: 1 }}>
          工厂管理系统 FMS
        </Typography.Title>
        <Space>
          {health ? (
            <Badge status={health.status === 'ok' ? 'success' : 'warning'} text={
              <span style={{ color: '#fff' }}>
                API {health.status} · 数据库 {health.db}
              </span>
            } />
          ) : (
            <Badge status="error" text={<span style={{ color: '#fff' }}>API 不可达</span>} />
          )}
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <CrudDemoCard />
      </Content>
    </Layout>
  )
}

/** I01 技术验证遗留：最小全栈 CRUD 演示（I03 起替换为真实主数据页） */
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
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Alert
          type="info" showIcon
          message="I01·I02 地基阶段"
          description={
            <Space direction="vertical" size={4}>
              <span>技术验证 CRUD（React19 + AntD6 → NestJS11 → PG18 + Drizzle）全链路已跑通。</span>
              <span>当前为演示数据区 —— I03 起将替换为真实主数据（产品/客户/供应商/操作人）与订单业务界面。</span>
              <span>
                功能入口规划：订单 / 计划单 / 排程 / 仓储 / 账目 / 设置&nbsp;
                {['订单', '计划单', '排程', '仓储', '账目'].map(s => <Tag key={s}>{s} 待建</Tag>)}
              </span>
            </Space>
          }
        />
      </Col>
      <Col span={24}>
        <Card
          title="I01 技术验证 · 最小全栈 CRUD"
          extra={<Space><Button type="primary" onClick={openCreate}>+ 新增</Button><Button onClick={fetchList}>刷新</Button></Space>}
        >
          <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="状态">全链路 CRUD 验证载体</Descriptions.Item>
            <Descriptions.Item label="说明">数据存 PostgreSQL，I03 迁移前保留</Descriptions.Item>
          </Descriptions>
          <Table rowKey="id" loading={loading} columns={columns} dataSource={items} />
        </Card>
      </Col>
      <Modal
        title={editing ? '编辑' : '新增'} open={modalOpen}
        onOk={handleSubmit} onCancel={() => setModalOpen(false)}
      >
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
    </Row>
  )
}
