import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../lib/api'
import { ROLE_LABELS, ROLE_OPTIONS } from '../lib/auth'
import type { UserRole } from '../lib/auth'

interface UserRow {
  id: number
  username: string
  displayName: string
  role: UserRole
  enabled: boolean
  operatorId: number | null
  createdAt?: string
}

interface OperatorRow { id: number; name: string; boundPc?: string | null }

const { Text } = Typography

/** 用户账号管理（仅 admin 可见；对应后端 /api/users，角色守卫已限 admin） */
export default function UserManageCard() {
  const [rows, setRows] = useState<UserRow[]>([])
  const [ops, setOps] = useState<OperatorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [form] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      setRows(await api<UserRow[]>('/users'))
    } catch (e) {
      message.error('加载用户失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    api<OperatorRow[]>('/operators').then(setOps).catch(() => { /* 操作人表为空时仅影响绑定下拉 */ })
  }, [])

  const openNew = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ role: 'workshop', enabled: true })
    setOpen(true)
  }

  const openEdit = (r: UserRow) => {
    setEditing(r)
    form.setFieldsValue({
      username: r.username,
      displayName: r.displayName,
      role: r.role,
      operatorId: r.operatorId ?? undefined,
      enabled: r.enabled,
      password: '',
    })
    setOpen(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          displayName: v.displayName,
          role: v.role,
          enabled: v.enabled,
          operatorId: v.operatorId ?? null,
        }
        if (v.password) body.password = v.password
        await api('/users/' + editing.id, { method: 'PATCH', body })
        message.success('已保存')
      } else {
        await api('/users', {
          method: 'POST',
          body: {
            username: v.username,
            password: v.password,
            displayName: v.displayName,
            role: v.role,
            operatorId: v.operatorId ?? null,
          },
        })
        message.success('用户已创建')
      }
      setOpen(false)
      await load()
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const columns: ColumnsType<UserRow> = [
    { title: '用户名', dataIndex: 'username', width: 130 },
    { title: '显示名', dataIndex: 'displayName', width: 130 },
    {
      title: '角色',
      dataIndex: 'role',
      width: 100,
      render: (v: UserRole) => <Tag color={v === 'admin' ? 'gold' : 'blue'}>{ROLE_LABELS[v] ?? v}</Tag>,
    },
    {
      title: '留痕绑定操作人',
      dataIndex: 'operatorId',
      width: 170,
      render: (v: number | null) => {
        if (v == null) return <Text type="secondary">未绑定（回退请求头）</Text>
        const o = ops.find((x) => x.id === v)
        return o ? o.name : 'id=' + v
      },
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      width: 90,
      render: (_v, r) => (
        <Button size="small" type="link" onClick={() => openEdit(r)}>
          编辑
        </Button>
      ),
    },
  ]

  return (
    <Card
      title="用户账号与角色权限"
      size="small"
      loading={loading}
      extra={
        <Space>
          <Button size="small" onClick={load}>刷新</Button>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openNew}>
            新增用户
          </Button>
        </Space>
      }
    >
      <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
        角色：管理员（全权）· 计划员（订单/计划单/排程/主数据）· 仓管（出入库/来料/盘点）·
        账务（收付款核销/成本）· 车间（报工）。读操作所有登录用户可用，写操作按上述角色限制。
        「留痕绑定操作人」用于把单据经办人固定到某个操作人（不绑定则用请求头 X-Operator-Id）。
      </div>
      <Table<UserRow> rowKey="id" size="small" columns={columns} dataSource={rows} pagination={false} />
      <Modal
        title={editing ? '编辑用户：' + editing.username : '新增用户'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }} autoComplete="off">
          <Form.Item
            name="username"
            label="用户名"
            rules={editing ? [] : [{ required: true, message: '请输入用户名' }, { min: 3, message: '用户名至少 3 位' }]}
          >
            <Input placeholder="登录名，如 workshop1" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="如：车间-张师傅" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select options={ROLE_OPTIONS} placeholder="请选择角色" />
          </Form.Item>
          <Form.Item name="operatorId" label="留痕绑定操作人（可选）">
            <Select
              allowClear
              placeholder="不绑定（回退请求头 X-Operator-Id）"
              options={ops.map((o) => ({ value: o.id, label: o.name + (o.boundPc ? '（' + o.boundPc + '）' : '') }))}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing ? '重置密码（留空 = 不改）' : '初始密码'}
            rules={editing ? [{ min: 6, message: '密码至少 6 位' }] : [{ required: true, message: '请输入初始密码' }, { min: 6, message: '密码至少 6 位' }]}
          >
            <Input.Password placeholder="至少 6 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12 }}>
            提示：为防止把自己锁在系统外，当前登录账号不能停用、也不能改成非管理员角色。
          </Text>
        </Form>
      </Modal>
    </Card>
  )
}
