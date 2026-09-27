import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import type { UserRole } from '../db/schema';
import type { AuthUser } from './auth.types';
import { JWT_EXPIRES_IN, jwtSecret } from './jwt.config';

/** bcrypt 计算强度（10 轮：约 60~100ms，兼顾安全与登录体验） */
const BCRYPT_ROUNDS = 10;

/** 自定义 JWT 载荷（sub=用户 id；不复用 @types/jsonwebtoken 的 JwtPayload，其 sub 类型为 string） */
interface FmsJwtPayload {
  sub: number;
  username: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

/** 数据库行 → 对外用户对象（剥离 passwordHash，避免任何接口泄漏哈希） */
export function toAuthUser(row: {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  operatorId: number | null;
}): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    operatorId: row.operatorId ?? null,
  };
}

/** 密码哈希（bcryptjs 纯 JS 实现：node:22-alpine 无编译工具链也能跑） */
export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);

@Injectable()
export class AuthService {
  /** 登录：用户名 + 密码 → { token, user }；失败一律 401（不区分用户不存在/密码错，防账号枚举） */
  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const [row] = await db.select().from(users).where(eq(users.username, username.trim())).limit(1);
    if (!row || !row.enabled) throw new UnauthorizedException('用户名或密码错误');
    const ok = await bcrypt.compare(password, row.passwordHash);
    if (!ok) throw new UnauthorizedException('用户名或密码错误');
    return { token: this.sign(row), user: toAuthUser(row) };
  }

  /** 校验 JWT → 当前用户（每次都回查数据库：停用/改角色立即生效，无需等 token 过期） */
  async verifyToken(token: string): Promise<AuthUser> {
    let payload: FmsJwtPayload;
    try {
      payload = jwt.verify(token, jwtSecret()) as unknown as FmsJwtPayload;
    } catch {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
    const sub = Number(payload?.sub);
    if (!Number.isFinite(sub)) throw new UnauthorizedException('登录已失效，请重新登录');
    const [row] = await db.select().from(users).where(eq(users.id, sub)).limit(1);
    if (!row || !row.enabled) throw new UnauthorizedException('账号不存在或已被停用，请联系管理员');
    return toAuthUser(row);
  }

  /** 修改自己的密码：校验原密码（失败 400，与登录失败区分，便于前端提示） */
  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<{ ok: true }> {
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) throw new UnauthorizedException('账号不存在，请重新登录');
    const ok = await bcrypt.compare(oldPassword, row.passwordHash);
    if (!ok) throw new BadRequestException('原密码不正确');
    if (await bcrypt.compare(newPassword, row.passwordHash)) {
      throw new BadRequestException('新密码不能与原密码相同');
    }
    await this.setPassword(userId, newPassword);
    return { ok: true };
  }

  /** 重置密码（用户管理 / 初始种子共用） */
  async setPassword(userId: number, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  private sign(row: { id: number; username: string; role: UserRole }): string {
    const payload = { sub: row.id, username: row.username, role: row.role };
    return jwt.sign(payload, jwtSecret(), { expiresIn: JWT_EXPIRES_IN });
  }
}
