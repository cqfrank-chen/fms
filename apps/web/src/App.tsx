import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Table, message, Typography, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'

interface TestProduct {
  id: number
  name: string
  sku: string
  note?: string
  createdAt: string
}

const API = '/api'

export default function App() {
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
      const data = await res.json()
      setItems(data)
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchList() }, [])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: TestProduct) {
    setEditing(record)
    form.setFieldsValue(record)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    try {
      if (editing) {
        const res = await fetch(`${API}/test-products/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        message.success('已更新')
      } else {
        const res = await fetch(`${API}/test-products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        message.success('已新增')
      }
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
      title: '操作',
      width: 140,
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openEdit(record)}>编辑</Button>
          <Button size="small" danger onClick={() => handleDelete(record)}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={3}>I01 技术验证 · 最小全栈 CRUD</Typography.Title>
      <Typography.Paragraph type="secondary">
        React 19 + AntD 6 → NestJS 11 → PostgreSQL 18 + Drizzle 全链路（技术验证票）
      </Typography.Paragraph>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreate}>+ 新增</Button>
        <Button onClick={fetchList}>刷新</Button>
      </Space>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={items} />
      <Modal
        title={editing ? '编辑' : '新增'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
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
    </div>
  )
}
