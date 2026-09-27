import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Tag, Typography, message } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import { api } from '../lib/api'

const { Text, Paragraph, Link } = Typography

interface AgentInfo { installed: boolean; online: boolean; lastRunAt?: string | null; lastResult?: string | null; version?: string | null }
interface ChangeItem { sha: string; message: string; date?: string | null; author?: string | null }
interface UpdateStatus {
  configured: boolean
  message?: string
  repo?: string
  branch?: string
  repoUrl?: string
  currentSha?: string
  currentShort?: string
  latestSha?: string | null
  latestShort?: string
  latestDate?: string | null
  latestMessage?: string
  hasUpdate?: boolean
  changelog?: ChangeItem[]
  checkedAt?: string
  agent?: AgentInfo
  pendingRequest?: { targetShort?: string; requestedAt?: string; file?: string } | null
}

/**
 * 设置页「系统更新」卡片（I13）：
 * 比对 GitHub 最新提交 → 下载更新包 → 提交更新请求；
 * 真正的重建/重启由宿主机更新代理（auto-update.bat）执行——容器不持有 Docker 权限。
 */
export default function UpdateCard() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'download' | 'apply' | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setSt(await api<UpdateStatus>('/update/status')) }
    catch (e) { message.error('检查更新失败：' + (e as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function doDownload() {
    setBusy('download')
    try {
      const r = await api<{ bytes: number; sha256: string; targetShort: string }>('/update/download', { method: 'POST' })
      message.success(`已下载 ${r.targetShort}（${(r.bytes / 1024 / 1024).toFixed(1)} MB，SHA256 ${r.sha256.slice(0, 12)}…）`)
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setBusy(null) }
  }

  async function doApply() {
    setBusy('apply')
    try {
      const r = await api<{ mode: string; message: string }>('/update/apply', { method: 'POST' })
      if (r.mode === 'agent') message.success(r.message)
      else message.warning(r.message, 8)
      load()
    } catch (e) { message.error((e as Error).message) }
    finally { setBusy(null) }
  }

  const agent = st?.agent
  const upToDate = st?.configured && st.hasUpdate === false

  return (
    <Card
      title="系统更新"
      size="small"
      styles={{ body: { paddingTop: 8 } }}
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>检查更新</Button>
      }
    >
      {!st && <Text type="secondary">正在检查…</Text>}

      {st && !st.configured && (
        <Alert type="warning" showIcon message="未配置更新源" description={st.message ?? '在服务器 .env 中设置 FMS_UPDATE_REPO=owner/repo 后重启服务'} />
      )}

      {st?.configured && (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap size={16}>
            <span>当前版本：<Text code>{st.currentShort}</Text></span>
            <span>远端最新：<Text code>{st.latestShort || '—'}</Text></span>
            {st.hasUpdate
              ? <Tag color="processing" icon={<SyncOutlined spin={false} />}>有新版本</Tag>
              : upToDate ? <Tag color="success">已是最新</Tag> : <Tag>无法比对（当前构建号未知）</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>
              源：<Link href={st.repoUrl} target="_blank">{st.repo}@{st.branch}</Link>
              {st.checkedAt ? `　检查于 ${st.checkedAt.slice(11, 19)}` : ''}
            </Text>
          </Space>

          {st.latestMessage && (
            <Text type="secondary" style={{ fontSize: 12 }}>最新提交：{st.latestMessage}{st.latestDate ? `（${st.latestDate.slice(0, 10)}）` : ''}</Text>
          )}

          <Space wrap>
            <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy === 'download'} onClick={doDownload} disabled={!st.hasUpdate}>
              下载更新包
            </Button>
            <Button danger icon={<SyncOutlined />} loading={busy === 'apply'} onClick={doApply} disabled={!st.hasUpdate}>
              一键更新（备份后重建）
            </Button>
          </Space>

          {agent?.installed ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              宿主更新代理：{agent.online ? <Tag color="success">在线</Tag> : <Tag color="warning">未响应</Tag>}
              {agent.lastRunAt ? `　最近运行 ${String(agent.lastRunAt).slice(0, 19).replace('T', ' ')}` : ''}
              {agent.lastResult ? `　结果：${String(agent.lastResult).slice(0, 60)}` : ''}
            </Text>
          ) : (
            <Alert
              type="info"
              showIcon
              message="未安装宿主更新代理"
              description={<span>点「一键更新」只会下载更新包并生成请求文件，仍需在服务器上运行 <Text code>system\upgrade.bat</Text>。若想真正一键完成，请在服务器上双击 <Text code>system\auto-update.bat</Text> 并选「安装为计划任务」（每 5 分钟检查一次更新请求）。</span>}
            />
          )}

          {st.pendingRequest && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              待处理更新请求：<Text code>{st.pendingRequest.targetShort}</Text>（{String(st.pendingRequest.requestedAt ?? '').slice(0, 19).replace('T', ' ')}）
            </Text>
          )}

          {!!st.changelog?.length && (
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>最近提交（用于判断更新内容）</Text>
              {st.changelog.slice(0, 6).map((c) => (
                <Paragraph key={c.sha} style={{ margin: 0, fontSize: 12 }}>
                  <Text code>{c.sha}</Text> {c.message}
                  {c.date ? <Text type="secondary">（{c.date.slice(0, 10)}{c.author ? ' ' + c.author : ''}）</Text> : null}
                </Paragraph>
              ))}
            </div>
          )}
        </Space>
      )}
    </Card>
  )
}
