import type { UserRole } from '../db/schema';

/** 登录态用户（AuthGuard 校验 JWT 后写入 req.user；绝不含 passwordHash） */
export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  /** 绑定的操作人 id（留痕用）；null = 未绑定，回退请求头 X-Operator-Id */
  operatorId: number | null;
}
