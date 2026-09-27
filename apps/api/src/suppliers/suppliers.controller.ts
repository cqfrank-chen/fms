import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SETTLEMENTS } from '../db/schema';
import type { Settlement } from '../db/schema';
import { Roles } from '../auth/decorators';
import { SuppliersService } from './suppliers.service';

export class CreateSupplierDto {
  @IsNotEmpty({ message: '供应商名必填' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  contact?: string;

  @IsOptional()
  @IsIn(SETTLEMENTS, { message: '结算方式不在词表内' })
  settlement?: Settlement;
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Roles('admin', 'planner')
  @Post()
  create(@Body() dto: CreateSupplierDto) {
    return this.service.create(dto);
  }

  @Roles('admin', 'planner')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateSupplierDto>) {
    return this.service.update(id, dto);
  }

  @Roles('admin', 'planner')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
