import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { UserRole } from '../db/schema';
import { hashPassword } from './auth.service';

/** 对外字段白名单：任何查询都不返回 password_hash */
const SAFE_COLUMNS = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  enabled: users.enabled,
  operatorId: users.operatorId,
  createdAt: users.createdAt,
};

export interface CreateUserInput {
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
  operatorId?: number | null;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  enabled?: boolean;
  operatorId?: number | null;
  password?: string;
}

/** 用户账号管理（仅 admin，见 users.controller.ts）：创建 / 列表 / 改角色改绑定 / 重置密码 */
@Injectable()
export class UsersService {
  list() {
    return db.select(SAFE_COLUMNS).from(users).orderBy(asc(users.id));
  }

  async create(input: CreateUserInput) {
    const username = input.username.trim();
    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (dup) throw new BadRequestException('用户名已存在：' + username);
    const passwordHash = await hashPassword(input.password);
    const [row] = await db
      .insert(users)
      .values({
        username,
        passwordHash,
        displayName: input.displayName.trim(),
        role: input.role,
        operatorId: input.operatorId ?? null,
      })
      .returning(SAFE_COLUMNS);
    return row;
  }

  async update(id: number, input: UpdateUserInput, actorId: number) {
    const [exist] = await db.select(SAFE_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
    if (!exist) throw new NotFoundException('用户不存在（id=' + id + '）');
    // 防自锁：不允许把自己停用或降级为非 admin，避免管理员把自己关在门外
    if (id === actorId) {
      if (input.enabled === false) throw new BadRequestException('不能停用当前登录的账号');
      if (input.role && input.role !== 'admin') throw new BadRequestException('不能修改当前登录账号的角色');
    }
    const patch: {
      displayName?: string;
      role?: UserRole;
      enabled?: boolean;
      operatorId?: number | null;
      passwordHash?: string;
    } = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName.trim();
    if (input.role !== undefined) patch.role = input.role;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.operatorId !== undefined) patch.operatorId = input.operatorId;
    if (input.password) patch.passwordHash = await hashPassword(input.password);
    if (Object.keys(patch).length === 0) return exist;
    const [row] = await db.update(users).set(patch).where(eq(users.id, id)).returning(SAFE_COLUMNS);
    return row;
  }
}
