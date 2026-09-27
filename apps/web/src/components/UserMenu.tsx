import { useState } from 'react'
import { Avatar, Button, Dropdown, Form, Input, Modal, Space, Typography, message } from 'antd'
import { DownOutlined, KeyOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { changePassword, logout, ROLE_LABELS } from '../lib/auth'
import type { AuthUser } from '../lib/auth'

/** 顶栏「当前用户」：显示 display_name + 角色中文名，提供修改密码 / 退出登录 */
export default function UserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<{ oldPassword: string; newPassword: string; confirm: string }>()

  const items: MenuProps['items'] = [
    { key: 'who', label: '账号：' + user.username + '（' + ROLE_LABELS[user.role] + '）', disabled: true },
    { type: 'divider' },
    { key: 'pwd', icon: <KeyOutlined />, label: '修改密码' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
  ]

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'pwd') setOpen(true)
    if (key === 'logout') {
      Modal.confirm({
        title: '确认退出登录？',
        content: '退出后需要重新输入账号密码。',
        okText: '退出',
        cancelText: '取消',
        onOk: () => {
          message.success('已退出登录')
          logout()
        },
      })
    }
  }

  async function submit() {
    const v = await form.validateFields()
    setSaving(true)
    try {
      await changePassword(v.oldPassword, v.newPassword)
      setOpen(false)
      form.resetFields()
      message.success('密码已修改，请用新密码重新登录')
      logout()
    } catch (e) {
      message.error('修改失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space size={0}>
      <Dropdown menu={{ items, onClick: onMenuClick }} trigger={['click']}>
        <Button type="text" style={{ color: 'rgba(255,255,255,.9)', paddingInline: 6 }}>
          <Space size={8}>
            <Avatar size={24} style={{ background: '#1677ff' }} icon={<UserOutlined />} />
            <Typography.Text style={{ color: '#fff', fontSize: 13 }}>{user.displayName}</Typography.Text>
            <Typography.Text style={{ color: 'rgba(255,255,255,.6)', fontSize: 12 }}>
              {ROLE_LABELS[user.role]}
            </Typography.Text>
            <DownOutlined style={{ color: 'rgba(255,255,255,.6)', fontSize: 10 }} />
          </Space>
        </Button>
      </Dropdown>
      <Modal
        title="修改密码"
        open={open}
        onCancel={() => { setOpen(false); form.resetFields() }}
        onOk={submit}
        confirmLoading={saving}
        okText="确认修改"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }} autoComplete="off">
          <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
            <Input.Password placeholder="原密码" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '新密码至少 6 位' }]}
          >
            <Input.Password placeholder="至少 6 位" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_rule, value) {
                  if (!value || getFieldValue('newPassword') === value) return Promise.resolve()
                  return Promise.reject(new Error('两次输入的新密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            修改成功后当前登录态会失效，需要用新密码重新登录。
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  )
}
