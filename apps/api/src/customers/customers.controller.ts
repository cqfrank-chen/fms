import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { SETTLEMENTS } from '../db/schema';
import type { Settlement } from '../db/schema';
import { Roles } from '../auth/decorators';
import { CustomersService } from './customers.service';

export class CreateCustomerDto {
  @IsNotEmpty({ message: '客户名必填' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  contact?: string;

  @IsOptional()
  @IsIn(SETTLEMENTS, { message: '结算方式不在词表内' })
  settlement?: Settlement;

  @IsOptional()
  @IsInt({ message: '账期天数须为整数' })
  @Min(0, { message: '账期不能为负' })
  creditDays?: number;
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  /** 列表：默认隐藏占位档案「（未建档客户·待补）」；includePlaceholders=1 显示（界面「显示占位档案」开关） */
  @Get()
  findAll(@Query('includePlaceholders') includePlaceholders?: string) {
    return this.service.findAll({ includePlaceholders });
  }

  @Roles('admin', 'planner')
  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.service.create(dto);
  }

  @Roles('admin', 'planner')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateCustomerDto>) {
    return this.service.update(id, dto);
  }

  @Roles('admin', 'planner')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
