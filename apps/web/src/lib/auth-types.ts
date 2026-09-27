/** 角色词表（与后端 db/schema.ts USER_ROLES、auth/permissions.ts 一一对应） */
export type UserRole = 'admin' | 'planner' | 'warehouse' | 'accounting' | 'workshop'

export const USER_ROLES: UserRole[] = ['admin', 'planner', 'warehouse', 'accounting', 'workshop']

/** 角色中文名（顶栏、用户管理下拉共用） */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  planner: '计划员',
  warehouse: '仓管',
  accounting: '账务',
  workshop: '车间',
}

export const ROLE_OPTIONS = USER_ROLES.map((v) => ({ value: v, label: ROLE_LABELS[v] }))
