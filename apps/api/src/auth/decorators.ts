import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '../db/schema';
import type { AuthUser } from './auth.types';

/** 免登录白名单标记（默认所有接口都要求登录） */
export const IS_PUBLIC_KEY = 'fms:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 角色白名单标记；不写 = 所有已登录用户可访问；admin 由 RolesGuard 无条件放行 */
export const ROLES_KEY = 'fms:roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** 取当前登录用户（AuthGuard 已写入 req.user；未登录时守卫会先抛 401） */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  return req.user as AuthUser;
});
