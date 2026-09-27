import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { PRODUCT_TYPES } from '../db/schema';
import type { ProductType } from '../db/schema';
import { Roles } from '../auth/decorators';
import { ProductsService } from './products.service';

export class CreateProductDto {
  @IsNotEmpty({ message: '产品名必填' })
  @IsString()
  name: string;

  @IsIn(PRODUCT_TYPES, { message: '类型须为 英式/美式 × 乙炔/丙烷 之一' })
  type: ProductType;

  @IsOptional()
  @IsString()
  defaultPackaging?: string;

  @IsOptional()
  @IsString()
  defaultRouting?: string;

  @IsOptional()
  @IsInt({ message: '安全库存须为整数' })
  @Min(0, { message: '安全库存不能为负' })
  safetyStock?: number;
}

/** 工序路线整表替换的入参（前端一次提交整条路线） */
interface RouteItem {
  processId: number;
  unitSeconds?: number | null;
  changeoverMinutes?: number | null;
}

@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Roles('admin', 'planner')
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.service.create(dto);
  }

  @Roles('admin', 'planner')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateProductDto>) {
    return this.service.update(id, dto);
  }

  @Roles('admin', 'planner')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  // ============ I13 工序路线配置 ============

  /** 工序字典（13 道种子，含泳道名）—— 编辑器右侧字典面板用 */
  @Get('processes')
  listProcesses() {
    return this.service.listProcessDictionary();
  }

  /** 某产品的工序路线（按 seq 排序，含字典字段） */
  @Get(':id/process-routes')
  listRoutes(@Param('id', ParseIntPipe) id: number) {
    return this.service.listProcessRoutes(id);
  }

  /** 整表替换某产品的工序路线（事务；服务端重排 seq 1..N） */
  @Roles('admin', 'planner')
  @Put(':id/process-routes')
  replaceRoutes(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { items?: RouteItem[] },
  ) {
    return this.service.replaceProcessRoutes(id, body?.items ?? []);
  }
}
