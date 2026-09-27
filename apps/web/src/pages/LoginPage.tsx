import { useState } from 'react'
import { Button, Card, Form, Input, Typography, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { login } from '../lib/auth'
import type { AuthUser } from '../lib/auth'

/** 登录页（路由 /login）：用户名 + 密码 → 写入 token 并进入主界面；失败在表单下方提示 */
export default function LoginPage({ onSuccess }: { onSuccess: (user: AuthUser) => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(values: { username: string; password: string }) {
    setLoading(true)
    setError(null)
    try {
      const user = await login(values.username.trim(), values.password)
      message.success('登录成功，欢迎 ' + user.displayName)
      onSuccess(user)
    } catch (e) {
      setError((e as Error).message || '登录失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f2540',
        padding: 16,
      }}
    >
      <Card style={{ width: 380 }} styles={{ body: { padding: 28 } }}>
        <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
          工厂生产管理系统
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          请使用管理员分配的账号登录
        </Typography.Text>
        <Form layout="vertical" onFinish={submit} style={{ marginTop: 20 }} autoComplete="off">
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" size="large" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
          </Form.Item>
          {error && (
            <div style={{ color: '#ff4d4f', fontSize: 13, marginBottom: 12 }}>{error}</div>
          )}
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            登录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
          初始管理员：admin / Fms@2026（首次登录后请立即在右上角「修改密码」）
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
