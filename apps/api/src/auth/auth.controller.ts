import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser, Public } from './decorators';

class LoginDto {
  @IsNotEmpty({ message: '用户名必填' })
  @IsString()
  username: string;

  @IsNotEmpty({ message: '密码必填' })
  @IsString()
  password: string;
}

class ChangePasswordDto {
  @IsNotEmpty({ message: '原密码必填' })
  @IsString()
  oldPassword: string;

  @IsNotEmpty({ message: '新密码必填' })
  @IsString()
  @MinLength(6, { message: '新密码至少 6 位' })
  @MaxLength(64, { message: '新密码最多 64 位' })
  newPassword: string;
}

/** 统一前缀 /api/auth：登录 / 当前用户 / 改密 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 登录（@Public 免登录白名单）：成功 200 → { token, user }；用户名或密码错 401 */
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.username, dto.password);
  }

  /** 当前登录用户（前端刷新后回填顶栏与菜单权限） */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /** 修改自己的密码（需登录 + 原密码校验；校验失败 400） */
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.oldPassword, dto.newPassword);
  }
}
