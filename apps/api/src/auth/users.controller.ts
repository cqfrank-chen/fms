import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { USER_ROLES } from '../db/schema';
import type { UserRole } from '../db/schema';
import type { AuthUser } from './auth.types';
import { CurrentUser, Roles } from './decorators';
import { UsersService } from './users.service';

class CreateUserDto {
  @IsNotEmpty({ message: '用户名必填' })
  @IsString()
  @MinLength(3, { message: '用户名至少 3 位' })
  @MaxLength(32, { message: '用户名最多 32 位' })
  username: string;

  @IsNotEmpty({ message: '初始密码必填' })
  @IsString()
  @MinLength(6, { message: '初始密码至少 6 位' })
  @MaxLength(64, { message: '初始密码最多 64 位' })
  password: string;

  @IsNotEmpty({ message: '显示名必填' })
  @IsString()
  displayName: string;

  @IsIn(USER_ROLES, { message: '角色非法（admin/planner/warehouse/accounting/workshop）' })
  role: UserRole;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '绑定操作人须为整数 id' })
  operatorId?: number | null;
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsIn(USER_ROLES, { message: '角色非法（admin/planner/warehouse/accounting/workshop）' })
  role?: UserRole;

  @IsOptional()
  @IsBoolean({ message: '启用状态须为布尔值' })
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '绑定操作人须为整数 id' })
  operatorId?: number | null;

  @IsOptional()
  @IsString()
  @MinLength(6, { message: '重置密码至少 6 位' })
  @MaxLength(64, { message: '重置密码最多 64 位' })
  password?: string;
}

/** 用户账号管理：仅 admin（类级 @Roles 生效） */
@Roles('admin')
@Controller('users')
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.svc.update(id, dto, actor.id);
  }
}
