import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
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

  /**
   * 列表 / 选择下拉共用的选项接口：默认隐藏占位产品「（未建档产品·待补）」。
   * - **列表页**：按界面「显示占位档案」开关决定是否带 includePlaceholders=1（默认隐藏）；
   * - **选择下拉**（甲方裁定 2，2026-10-05）：一律显式带 includePlaceholders=1，让占位产品始终可选，
   *   便于把订单行**改指**到真实产品，或保留占位以维持待补状态；
   *   该参数还会幂等地**保证占位产品存在**（干净库里下拉同样能选到，见 common/pending-entities.ts）。
   */
  /**
   * 列表查询参数（除 includePlaceholders 外，本轮新增四个筛选；不传 = 不筛）：
   *   · series    目录系列 / 款式（精确匹配，如 'AMERICAN STYLE CUTTING TIP'）
   *   · gasType   目录气体类型：LPG / ACETYLENE（兼容写法 'ACE' 即乙炔）
   *   · anchor    锚定状态：matched（已锚定）/ unmatched（未锚定）
   *   · kw        关键词（产品名 / 基础型号 / size / 系列 模糊匹配）
   * 返回顺序固定为「按系列（官方目录顺序）分组 → 型号 → size → id」。
   */
  @Get()
  findAll(
    @Query('includePlaceholders') includePlaceholders?: string,
    @Query('series') series?: string,
    @Query('gasType') gasType?: string,
    @Query('anchor') anchor?: string,
    @Query('kw') kw?: string,
  ) {
    return this.service.findAll({ includePlaceholders, series, gasType, anchor, kw });
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
