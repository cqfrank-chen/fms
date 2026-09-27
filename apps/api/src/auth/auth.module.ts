import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * 登录鉴权模块：/api/auth（登录 · me · 改密）+ /api/users（管理员账号维护）。
 * 全局 AuthGuard / RolesGuard 在 app.module.ts 注册为 APP_GUARD，本模块导出 AuthService 供其注入。
 */
@Module({
  controllers: [AuthController, UsersController],
  providers: [AuthService, UsersService],
  exports: [AuthService],
})
export class AuthModule {}
