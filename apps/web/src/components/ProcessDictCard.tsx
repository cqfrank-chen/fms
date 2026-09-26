import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import { ApartmentOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ToolOutlined } from '@ant-design/icons'
import { api } from '../lib/api'

interface ProcessRow {
  id: number; key: string; name: string; wcKey: string
  wcName?: string | null; sortOrder: number; usedByProducts: number
}
interface WorkCenterRow {
  key: string; name: string; machines: number; sortOrder: number; processCount: number
}

/**
 * 工序字典维护：增减/编辑「工序类型」与「工作中心（泳道）」。
 * - 工序挂在泳道下；被产品工艺路线引用时禁止删除（后端返回可读原因）
 * - 变更后通过 onChanged 通知「产品工序路线」刷新字典
 */
export default function ProcessDictCard({ onChanged }: { onChanged?: () => void }) {
  const [processes, setProcesses] = useState<ProcessRow[]>([])
  const [centers, setCenters] = useState<WorkCenterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [procModal, setProcModal] = useState<{ open: boolean; editing: ProcessRow | null }>({ open: false, editing: null })
  const [wcModal, setWcModal] = useState<{ open: boolean; editing: WorkCenterRow | null }>({ open: false, editing: null })
  const [procForm] = Form.useForm()
  const [wcForm] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ps, cs] = await Promise.all([api<ProcessRow[]>('/processes'), api<WorkCenterRow[]>('/work-centers')])
      setProcesses(ps)
      setCenters(cs)
    } catch (e) {
      message.error('加载工序字典失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  function openProcess(row?: ProcessRow) {
    setProcModal({ open: true, editing: row ?? null })
    if (row) procForm.setFieldsValue({ name: row.name, wcKey: row.wcKey, sortOrder: row.sortOrder })
    else procForm.resetFields()
  }
  async function saveProcess() {
    const v = await procForm.validateFields()
    setSaving(true)
    try {
      if (procModal.editing) await api(`/processes/${procModal.editing.id}`, { method: 'PATCH', body: v })
      else await api('/processes', { method: 'POST', body: v })
      message.success(procModal.editing ? '工序已更新' : '工序已新增')
      setProcModal({ open: false, editing: null })
      await load()
      onChanged?.()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  async function removeProcess(row: ProcessRow) {
    try {
      await api(`/processes/${row.id}`, { method: 'DELETE' })
      message.success(`工序「${row.name}」已删除`)
      await load()
      onChanged?.()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  function openCenter(row?: WorkCenterRow) {
    setWcModal({ open: true, editing: row ?? null })
    if (row) wcForm.setFieldsValue({ name: row.name, machines: row.machines, sortOrder: row.sortOrder })
    else wcForm.setFieldsValue({ machines: 1 })
  }
  async function saveCenter() {
    const v = await wcForm.validateFields()
    setSaving(true)
    try {
      if (wcModal.editing) await api(`/work-centers/${wcModal.editing.key}`, { method: 'PATCH', body: v })
      else await api('/work-centers', { method: 'POST', body: v })
      message.success(wcModal.editing ? '工作中心已更新' : '工作中心已新增')
      setWcModal({ open: false, editing: null })
      await load()
      onChanged?.()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  async function removeCenter(row: WorkCenterRow) {
    try {
      await api(`/work-centers/${row.key}`, { method: 'DELETE' })
      message.success(`工作中心「${row.name}」已删除`)
      await load()
      onChanged?.()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const processTab = (
    <>
      <Space style={{ marginBottom: 8 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openProcess()}>新增工序</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          工序类型即生产步骤（如下料/车削/…）；新增后可在「产品工序路线」中勾选并填写单件耗时
        </Typography.Text>
      </Space>
      <Table<ProcessRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={processes}
        pagination={false}
        columns={[
          { title: '工序名称', dataIndex: 'name', render: (v: string, r: ProcessRow) => <Space size={6}><ToolOutlined style={{ color: '#1677ff' }} /><span>{v}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.key}</Typography.Text></Space> },
          { title: '所属泳道', dataIndex: 'wcName', width: 160, render: (v: string | null, r: ProcessRow) => <Tag color="blue">{v ?? r.wcKey}</Tag> },
          { title: '使用产品数', dataIndex: 'usedByProducts', width: 110, align: 'right', render: (v: number) => (v > 0 ? v : <Typography.Text type="secondary">未使用</Typography.Text>) },
          { title: '排序', dataIndex: 'sortOrder', width: 80, align: 'right' },
          {
            title: '操作', width: 140,
            render: (_: unknown, r: ProcessRow) => (
              <Space size={4}>
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openProcess(r)}>编辑</Button>
                <Popconfirm
                  title={`删除工序「${r.name}」？`}
                  description="被产品工艺路线使用的工序不能删除；删除后不可恢复。"
                  okText="删除" okButtonProps={{ danger: true }} cancelText="取消"
                  onConfirm={() => removeProcess(r)}
                >
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </>
  )

  const centerTab = (
    <>
      <Space style={{ marginBottom: 8 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCenter()}>新增工作中心</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          工作中心 = 排程看板的泳道（产能池），可并行设备数用于自动推算工期
        </Typography.Text>
      </Space>
      <Table<WorkCenterRow>
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={centers}
        pagination={false}
        columns={[
          { title: '泳道名称', dataIndex: 'name', render: (v: string, r: WorkCenterRow) => <Space size={6}><ApartmentOutlined style={{ color: '#722ed1' }} /><span>{v}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.key}</Typography.Text></Space> },
          { title: '可并行设备数', dataIndex: 'machines', width: 130, align: 'right' },
          { title: '工序数', dataIndex: 'processCount', width: 90, align: 'right' },
          { title: '排序', dataIndex: 'sortOrder', width: 80, align: 'right' },
          {
            title: '操作', width: 140,
            render: (_: unknown, r: WorkCenterRow) => (
              <Space size={4}>
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openCenter(r)}>编辑</Button>
                <Popconfirm
                  title={`删除工作中心「${r.name}」？`}
                  description="下仍有工序或计划行时不能删除；删除后不可恢复。"
                  okText="删除" okButtonProps={{ danger: true }} cancelText="取消"
                  onConfirm={() => removeCenter(r)}
                >
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </>
  )

  return (
    <Card title="工序字典 · 工作中心（可增删改）" size="small">
      <Tabs
        size="small"
        items={[
          { key: 'process', label: `工序类型（${processes.length}）`, children: processTab },
          { key: 'wc', label: `工作中心 / 泳道（${centers.length}）`, children: centerTab },
        ]}
      />

      <Modal
        title={procModal.editing ? '编辑工序' : '新增工序'}
        open={procModal.open}
        onOk={saveProcess}
        confirmLoading={saving}
        onCancel={() => setProcModal({ open: false, editing: null })}
        okText="保存" cancelText="取消"
        destroyOnHidden
      >
        <Form form={procForm} layout="vertical">
          <Form.Item name="name" label="工序名称" rules={[{ required: true, message: '请填写工序名称' }]}>
            <Input placeholder="如：去毛刺" maxLength={30} />
          </Form.Item>
          <Form.Item name="wcKey" label="所属工作中心（泳道）" rules={[{ required: true, message: '请选择工作中心' }]}>
            <Select placeholder="选择泳道" options={centers.map((c) => ({ value: c.key, label: c.name }))} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序（可空，默认排到最后）">
            <InputNumber min={0} style={{ width: '100%' }} placeholder="数字越小越靠前" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={wcModal.editing ? '编辑工作中心' : '新增工作中心'}
        open={wcModal.open}
        onOk={saveCenter}
        confirmLoading={saving}
        onCancel={() => setWcModal({ open: false, editing: null })}
        okText="保存" cancelText="取消"
        destroyOnHidden
      >
        <Form form={wcForm} layout="vertical">
          <Form.Item name="name" label="泳道名称" rules={[{ required: true, message: '请填写泳道名称' }]}>
            <Input placeholder="如：热处理" maxLength={30} />
          </Form.Item>
          <Form.Item name="machines" label="可并行设备数" rules={[{ required: true, message: '请填写设备数' }]} initialValue={1}>
            <InputNumber min={1} max={99} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序（可空，默认排到最后）">
            <InputNumber min={0} style={{ width: '100%' }} placeholder="数字越小越靠上" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            编码由系统自动生成（如 wc_1），用于数据关联，无需填写。
          </Typography.Text>
        </Form>
      </Modal>
    </Card>
  )
}
