import { useState } from 'react'
import { Alert, Button, Card, Radio, Space, Table, Tag, Typography, Upload, message } from 'antd'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { DownloadOutlined, InboxOutlined } from '@ant-design/icons'
import { api } from '../lib/api'
import { getToken } from '../lib/token'
import { PRODUCT_TYPE_LABEL, SETTLEMENT_LABEL } from '../lib/labels'

/**
 * 主数据批量导入（客户 / 产品）：选择文件 → 解析预览 + 逐行校验 → 确认导入 → 结果汇总。
 *
 * 约定：
 * - 支持 .xls（Excel 97-2003）/ .xlsx / .csv，实际类型由后端按文件 magic bytes 判定（扩展名写错也能识别）；
 * - **上传不写库**：先预览（每行标记 新增/更新/跳过/错误 + 原因），点「确认导入」才落库；
 * - 模式：仅新增（已存在则跳过）/ 新增或更新（已存在则更新非空字段）；
 * - 文件经 dataURL 直送（与 AI 识单上传同一协议，不走 multipart）。
 */

type ImportTarget = 'customers' | 'products'
type ImportMode = 'insert-only' | 'upsert'
type RowStatus = 'new' | 'update' | 'skip' | 'error'

interface PreviewRow {
  rowNo: number
  status: RowStatus
  reasons: string[]
  data: Record<string, string | number | null>
  existingId?: number | null
  changedFields?: string[]
}

interface ImportSummary { total: number; new: number; update: number; skip: number; error: number }

interface PreviewResult {
  target: ImportTarget
  mode: ImportMode
  fileKind: string
  headerRowIndex: number
  columns: Record<string, number>
  unmappedHeaders: string[]
  summary: ImportSummary
  rows: PreviewRow[]
}

interface CommitResult {
  summary: ImportSummary
  created: Array<{ rowNo: number; id: number; name: string }>
  updated: Array<{ rowNo: number; id: number; name: string; fields: string[] }>
  failures: Array<{ rowNo: number; name: string; reason: string }>
}

const STATUS_META: Record<RowStatus, { text: string; color: string }> = {
  new: { text: '新增', color: 'green' },
  update: { text: '更新', color: 'blue' },
  skip: { text: '跳过', color: 'default' },
  error: { text: '错误', color: 'red' },
}

const TARGET_META: Record<ImportTarget, { label: string; columns: Array<[string, string, (v: unknown) => string]>; hint: string }> = {
  customers: {
    label: '客户',
    hint: '表头：客户名称（必填）/ 联系人 / 结算方式 / 账期天数',
    columns: [
      ['name', '客户名称', (v) => String(v ?? '—')],
      ['contact', '联系人', (v) => String(v ?? '—')],
      ['settlement', '结算方式', (v) => (v ? SETTLEMENT_LABEL[String(v)] ?? String(v) : '—')],
      ['creditDays', '账期天数', (v) => (v === null || v === undefined ? '—' : String(v))],
    ],
  },
  products: {
    label: '产品',
    hint: '表头：型号（必填）/ 类型（必填）/ 默认包装 / 默认工序路线 / 安全库存',
    columns: [
      ['name', '型号', (v) => String(v ?? '—')],
      ['type', '类型', (v) => (v ? PRODUCT_TYPE_LABEL[String(v)] ?? String(v) : '—')],
      ['defaultPackaging', '默认包装', (v) => String(v ?? '—')],
      ['defaultRouting', '默认工序路线', (v) => String(v ?? '—')],
      ['safetyStock', '安全库存', (v) => (v === null || v === undefined ? '—' : String(v))],
    ],
  },
}

const MAX_FILE = 8 * 1024 * 1024

interface Props {
  target: ImportTarget
  /** 卡片标题（与相邻的 CRUD 卡片区分） */
  title: string
  /** 导入成功后的回调（刷新同页实体统计/列表） */
  onChanged?: () => void
}

export default function MasterImportCard({ target, title, onChanged }: Props) {
  const meta = TARGET_META[target]
  const [mode, setMode] = useState<ImportMode>('insert-only')
  const [fileName, setFileName] = useState('')
  const [dataUrl, setDataUrl] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [result, setResult] = useState<CommitResult | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)

  /** 预览：带文件直送后端解析（不写库） */
  async function doPreview(file: string, name: string, m: ImportMode = mode) {
    setBusy('preview')
    setResult(null)
    try {
      const r = await api<PreviewResult>('/master-data/import/preview', {
        method: 'POST',
        body: { target, mode: m, file, fileName: name },
      })
      setPreview(r)
      if (!r.summary.new && !r.summary.update) {
        message.info('没有需要导入的行（' + r.summary.total + ' 行全部为跳过/错误），请检查文件或改用「新增或更新」模式')
      }
    } catch (e) {
      setPreview(null)
      message.error('解析预览失败：' + (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** 确认导入：先重新解析校验（后端保证失败即中止、不发写），再逐行事务落库 */
  async function doCommit() {
    if (!dataUrl) return
    setBusy('commit')
    try {
      const r = await api<CommitResult>('/master-data/import/commit', {
        method: 'POST',
        body: { target, mode, file: dataUrl, fileName },
      })
      setResult(r)
      const s = r.summary
      if (s.error) {
        message.warning('导入完成：新增 ' + s.new + '，更新 ' + s.update + '，跳过 ' + s.skip + '，失败 ' + s.error + '（详见失败清单）')
      } else {
        message.success('导入完成：新增 ' + s.new + '，更新 ' + s.update + '，跳过 ' + s.skip)
      }
      onChanged?.()
    } catch (e) {
      message.error('导入失败（未写入任何数据）：' + (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function doDownloadTemplate() {
    try {
      const res = await fetch('/api/master-data/import/template?target=' + target, {
        headers: { Authorization: 'Bearer ' + (getToken() ?? '') },
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') ?? ''
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
      const name = m ? decodeURIComponent(m[1]) : meta.label + '导入模板.csv'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      message.error('模板下载失败：' + (e as Error).message)
    }
  }

  const uploadProps: UploadProps = {
    accept: '.xls,.xlsx,.csv,.tsv',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      const f = file as unknown as File
      const name = f.name.toLowerCase()
      if (!/\.(xls|xlsx|csv|tsv)$/.test(name)) { message.error('仅支持 .xls / .xlsx / .csv 表格文件'); return false }
      if (f.size > MAX_FILE) { message.error('文件超过 8MB，请精简后重试（大表可另存为 .csv）'); return false }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        setFileName(f.name)
        setDataUrl(url)
        void doPreview(url, f.name)
      }
      reader.onerror = () => message.error('文件读取失败，请重新选择')
      reader.readAsDataURL(f)
      return false // 阻止自动上传：统一由前端转 dataURL 直送
    },
  }

  const previewColumns: ColumnsType<PreviewRow> = [
    { title: '行号', dataIndex: 'rowNo', width: 70, align: 'right' },
    {
      title: '结论', dataIndex: 'status', width: 90,
      render: (s: RowStatus) => <Tag color={STATUS_META[s].color}>{STATUS_META[s].text}</Tag>,
    },
    ...meta.columns.map(([key, label, fmt]) => ({
      title: label,
      key,
      ellipsis: true,
      render: (_: unknown, row: PreviewRow) => fmt(row.data[key]),
    })),
    {
      title: '原因 / 说明', dataIndex: 'reasons', ellipsis: true,
      render: (reasons: string[]) => (reasons?.length ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{reasons.join('；')}</Typography.Text> : '—'),
    },
  ]

  const s = preview?.summary

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space size={8}>
          <Button size="small" icon={<DownloadOutlined />} onClick={doDownloadTemplate}>下载导入模板</Button>
          {dataUrl && <Button size="small" loading={busy === 'preview'} onClick={() => void doPreview(dataUrl, fileName)}>重新预览</Button>}
        </Space>
      }
    >
      <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
        支持 .xls（Excel 97-2003）/ .xlsx / .csv；{meta.hint}。上传只做预览校验，点「确认导入」才写库；单文件 ≤ 8MB。
      </div>
      <Space wrap size={12} style={{ marginBottom: 8 }}>
        <Radio.Group
          size="small"
          value={mode}
          onChange={(e) => {
            const m = e.target.value as ImportMode
            setMode(m)
            setResult(null)
            // 模式影响「新增/更新/跳过」判定，已有文件时立即按新模重新预览
            if (dataUrl) void doPreview(dataUrl, fileName, m)
          }}
        >
          <Radio.Button value="insert-only">仅新增（已存在则跳过）</Radio.Button>
          <Radio.Button value="upsert">新增或更新（已存在则更新非空字段）</Radio.Button>
        </Radio.Group>
      </Space>
      <Upload.Dragger {...uploadProps} disabled={!!busy}>
        <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}><InboxOutlined /></p>
        <p className="ant-upload-text" style={{ fontSize: 14 }}>点击选择或把{meta.label}表格拖到这里</p>
        <p className="ant-upload-hint" style={{ fontSize: 12 }}>
          建议先「下载导入模板」按中文表头填写；表头别名宽容（如客户名称/客户简称、型号/品名、单位/计量单位）
        </p>
      </Upload.Dragger>

      {preview && s && (
        <div style={{ marginTop: 12 }}>
          <Space wrap size={8} style={{ marginBottom: 8 }}>
            <Typography.Text strong>预览（{fileName}，{preview.fileKind}）</Typography.Text>
            <Tag color="green">新增 {s.new}</Tag>
            <Tag color="blue">更新 {s.update}</Tag>
            <Tag>跳过 {s.skip}</Tag>
            <Tag color={s.error ? 'red' : 'default'}>错误 {s.error}</Tag>
            <Button
              type="primary"
              size="small"
              loading={busy === 'commit'}
              disabled={!s.new && !s.update}
              onClick={doCommit}
            >
              确认导入（{s.new + s.update} 行）
            </Button>
          </Space>
          {preview.unmappedHeaders.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={'未识别的列（不会导入）：' + preview.unmappedHeaders.join('、')}
            />
          )}
          <Table<PreviewRow>
            size="small"
            rowKey="rowNo"
            columns={previewColumns}
            dataSource={preview.rows}
            pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
            scroll={{ x: 900 }}
            rowClassName={(row) => (row.status === 'error' ? 'master-import-row-error' : '')}
          />
        </div>
      )}

      {result && (
        <Alert
          style={{ marginTop: 12 }}
          type={result.summary.error ? 'warning' : 'success'}
          showIcon
          message={
            '导入结果：新增 ' + result.summary.new + '，更新 ' + result.summary.update
            + '，跳过 ' + result.summary.skip + '，失败 ' + result.summary.error
          }
          description={result.failures.length > 0 ? (
            <div style={{ fontSize: 12 }}>
              <div style={{ marginBottom: 4 }}>失败清单（未写入，可修正后重新导入）：</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {result.failures.map((f) => (
                  <li key={f.rowNo + '-' + f.name}>第 {f.rowNo} 行{f.name ? '（' + f.name + '）' : ''}：{f.reason}</li>
                ))}
              </ul>
            </div>
          ) : '全部行处理完成'}
        />
      )}
    </Card>
  )
}
