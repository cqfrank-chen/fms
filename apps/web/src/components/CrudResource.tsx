import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ReactNode } from 'react'
import { api } from '../lib/api'

/** 表单字段配置：驱动弹窗生成与基础校验 */
export interface FieldConfig {
  name: string
  label: string
  required?: boolean
  /**
   * packagings = 「默认包装」多值编辑器（Form.List）：
   * 同一型号可以有多种默认包装（甲方规则 2026），每行一个包装 + 可选备注。
   */
  kind?: 'text' | 'number' | 'select' | 'packagings'
  options?: { value: string; label: string }[]
  placeholder?: string
  min?: number
}

interface CrudResourceProps<T extends { id: number }> {
  /** 卡片标题 */
  title: string
  /** REST 资源路径（如 'products'，实际请求 /api/products） */
  resource: string
  /** 表格列定义（值渲染、枚举文案映射由调用方负责） */
  columns: ColumnsType<T>
  /** 弹窗表单字段 */
  fields: FieldConfig[]
  /** 新建时的初始值（可选） */
  initialValues?: Record<string, unknown>
  /** 增删改成功后回调（用于通知同页其它卡片刷新，如实体统计/产品工序路线） */
  onChanged?: () => void
  /**
   * 列表请求附加查询串（含前导 '?' 或 '&'）。
   * I17：客户/产品列表默认隐藏占位档案，「显示占位档案」开关打开时传 '?includePlaceholders=1'。
   * 本轮的筛选（系列 / 气体类型 / 锚定状态 / 关键词）也走这里；值变化即自动重新拉取。
   */
  listQuery?: string
  /** 卡片顶部工具条（筛选控件等，放在「+ 新增」左侧的表头上方） */
  toolbar?: ReactNode
  /** 表格横向滚动宽度（列多时避免挤压换行；不传 = 不横向滚动） */
  scrollX?: number
}

/** 通用主数据 CRUD：列表 + 弹窗表单增删改，直接生效无草稿态（对齐票 09 原型设置页） */
export default function CrudResource<T extends { id: number }>({
  title,
  resource,
  columns,
  fields,
  initialValues,
  onChanged,
  listQuery = '',
  toolbar,
  scrollX,
}: CrudResourceProps<T>) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<T | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  async function fetchRows() {
    setLoading(true)
    try {
      setRows(await api<T[]>(`/${resource}${listQuery}`))
    } catch (e) {
      message.error('加载失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchRows() }, [listQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue(initialValues ?? {})
    setModalOpen(true)
  }

  function openEdit(record: T) {
    setEditing(record)
    form.resetFields()
    // 编辑回填：仅填字段配置内的键（忽略 createdAt 等只读字段）
    const values: Record<string, unknown> = {}
    for (const f of fields) {
      const v = (record as unknown as Record<string, unknown>)[f.name]
      if (v !== undefined) values[f.name] = v
    }
    form.setFieldsValue(values)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    // 去掉 null（InputNumber 清空返回 null；后端可选字段省略而非置空）
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined) continue
      // 数组字段（默认包装多值）：丢掉空行，避免后端 DTO 因「包装内容必填」报 400
      if (Array.isArray(v)) {
        clean[k] = v.filter((x) => x && String((x as { packaging?: string }).packaging ?? '').trim())
        continue
      }
      clean[k] = v
    }
    setSaving(true)
    try {
      if (editing) {
        await api(`/${resource}/${editing.id}`, { method: 'PATCH', body: clean })
        message.success('已更新')
      } else {
        await api(`/${resource}`, { method: 'POST', body: clean })
        message.success('已新增')
      }
      setModalOpen(false)
      fetchRows()
      onChanged?.()
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(record: T) {
    try {
      await api(`/${resource}/${record.id}`, { method: 'DELETE' })
      message.success('已删除')
      fetchRows()
      onChanged?.()
    } catch (e) {
      message.error('删除失败：' + (e as Error).message)
    }
  }

  const actionColumn: ColumnsType<T>[number] = {
    title: '操作',
    width: 140,
    render: (_, record) => (
      <Space>
        <Button size="small" onClick={() => openEdit(record)}>编辑</Button>
        <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record)}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      </Space>
    ),
  }

  return (
    <Card
      title={title}
      size="small"
      styles={{ body: { paddingTop: 8 } }}
      extra={<Button type="primary" size="small" onClick={openCreate}>+ 新增</Button>}
    >
      {toolbar && <div style={{ marginBottom: 8 }}>{toolbar}</div>}
      <Table<T>
        rowKey="id"
        size="small"
        loading={loading}
        columns={[...columns, actionColumn]}
        dataSource={rows}
        scroll={scrollX ? { x: scrollX } : undefined}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
      />
      <Modal
        title={editing ? '编辑' : '新增'}
        open={modalOpen}
        onOk={handleSubmit}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {fields.map((f) => {
            const rules = []
            if (f.required) rules.push({ required: true, message: `${f.label}必填` })
            if (f.kind === 'number' && f.min !== undefined)
              rules.push({ type: 'number' as const, min: f.min, message: `${f.label}不能小于 ${f.min}` })
            return (
              <Form.Item
                key={f.name}
                name={f.name}
                label={f.label}
                rules={rules}
                // packagings 是 Form.List（值挂在 f.name 下），校验/回填方式与普通字段一致
                {...(f.kind === 'packagings' ? { valuePropName: undefined } : {})}
              >
                {f.kind === 'packagings' ? (
                  <Form.List name={f.name}>
                    {(items, { add, remove }) => (
                      <div>
                        {items.map((it) => (
                          <Space key={it.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                            <Form.Item
                              {...it}
                              name={[it.name, 'packaging']}
                              rules={[{ required: true, message: '包装内容必填' }]}
                              style={{ marginBottom: 0, width: 240 }}
                            >
                              <Input placeholder={f.placeholder ?? '如：塑壳 红盖 不干胶 50只/中盒'} />
                            </Form.Item>
                            <Form.Item
                              {...it}
                              name={[it.name, 'note']}
                              style={{ marginBottom: 0, width: 180 }}
                            >
                              <Input placeholder="该包装备注（可选）" />
                            </Form.Item>
                            <Button size="small" danger type="link" onClick={() => remove(it.name)}>
                              删除
                            </Button>
                          </Space>
                        ))}
                        <Button size="small" type="dashed" onClick={() => add({ packaging: '', note: '' })}>
                          + 添加默认包装
                        </Button>
                        <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                          同一型号可以有多种默认包装（第一条会同步到既有「默认包装」文本字段）
                        </div>
                      </div>
                    )}
                  </Form.List>
                ) : f.kind === 'number' ? (
                  <InputNumber style={{ width: '100%' }} min={f.min ?? 0} placeholder={f.placeholder} />
                ) : f.kind === 'select' ? (
                  <Select
                    allowClear
                    placeholder={f.placeholder ?? '请选择'}
                    options={f.options}
                    notFoundContent="词表内无匹配项"
                  />
                ) : (
                  <Input placeholder={f.placeholder} />
                )}
              </Form.Item>
            )
          })}
        </Form>
      </Modal>
    </Card>
  )
}
