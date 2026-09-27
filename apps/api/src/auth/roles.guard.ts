import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../db/schema';
import type { AuthUser } from './auth.types';
import { ROLES_KEY } from './decorators';
import { ROLE_LABELS } from './permissions';

/**
 * 角色守卫（APP_GUARD，排在 AuthGuard 之后）：
 *   · 接口未标注 @Roles → 放行（= 读操作对所有登录用户开放）
 *   · admin 无条件放行（全权；权限矩阵见 ./permissions.ts 顶部注释）
 *   · 其余角色命中 @Roles 列表才放行，否则 403
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException('未登录，请先登录');
    if (user.role === 'admin') return true;
    if (required.includes(user.role)) return true;

    const need = required.map((r) => ROLE_LABELS[r]).join(' / ');
    throw new ForbiddenException('当前角色（' + ROLE_LABELS[user.role] + '）无权执行该操作，需要：' + need);
  }
}
