import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUser } from './auth.types';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './decorators';

/** 全局登录守卫（APP_GUARD）：未带有效 token 一律 401；仅 @Public() 标记的接口放行。
 *  白名单：GET /api/health、POST /api/auth/login。 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const raw = req.headers?.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('未登录，请先登录');
    // 校验通过后写入 req.user：RolesGuard、@CurrentUser 与留痕拦截器共用
    req.user = await this.auth.verifyToken(token);
    return true;
  }
}
