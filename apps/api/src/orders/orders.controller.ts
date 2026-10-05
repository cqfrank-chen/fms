import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional,
  IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/decorators';
import { CURRENCIES } from '../db/schema';
import type { Currency, OrderStatus } from '../db/schema';
import { OrdersService } from './orders.service';
import type { CreateDraftOrderDto } from './orders.service';
import { PlanSheetsService } from '../plan-sheets/plan-sheets.service';

class OrderLineDto {
  @IsInt()
  productId: number;

  @IsInt()
  @Min(1, { message: '数量至少 1' })
  quantity: number;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: '单价须为数字' })
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: Currency;

  @IsOptional()
  @IsString()
  engraving?: string;

  @IsOptional()
  @IsObject({ message: '包装要求格式不正确' })
  packaging?: Record<string, string>;
}

export class CreateOrderDto {
  @IsInt({ message: '客户必选' })
  customerId: number;

  @IsOptional()
  @IsString()
  poNo?: string;

  @IsNotEmpty({ message: '交期必填' })
  @IsString()
  dueDate: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ArrayMinSize(1, { message: '至少一个产品行' })
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines: OrderLineDto[];
}

/**
 * 落草稿行的入参（I17）：productId / quantity / unitPrice **都可缺**——
 * 缺的项不阻断落库，改为在行上标「待补」（产品未建档 / 缺数量 / 缺单价）。
 */
class DraftOrderLineDto {
  @IsOptional() @IsInt() productId?: number | null;

  @IsOptional() @IsString() productName?: string | null;

  @IsOptional() @IsNumber() quantity?: number | null;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }, { message: '单价须为数字（最多 2 位小数）' }) @Min(0) unitPrice?: number | null;

  @IsOptional() @IsIn(CURRENCIES) currency?: Currency;

  @IsOptional() @IsString() engraving?: string;

  @IsOptional() @IsObject({ message: '包装要求格式不正确' }) packaging?: Record<string, string>;

  /** 单价来源：'quote' = 识单时已按报价记录补价（补价成功的行不再算缺价） */
  @IsOptional() @IsIn(['quote']) priceFrom?: 'quote' | null;

  @IsOptional() @IsInt() quoteId?: number | null;
}

/** 落草稿订单入参：不要求客户/交期/产品都在档案（缺的项落「待补」标记） */
export class CreateDraftOrderDtoBody {
  @IsOptional() @IsInt() customerId?: number | null;

  @IsOptional() @IsString() customerName?: string | null;

  /** 文件夹客户（甲方裁定「文件夹=客户」）：优先于 customerName */
  @IsOptional() @IsString() @MaxLength(64) folderCustomer?: string | null;

  @IsOptional() @IsString() poNo?: string | null;

  @IsOptional() @IsString() dueDate?: string | null;

  @IsOptional() @IsString() note?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DraftOrderLineDto)
  lines: DraftOrderLineDto[];
}

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly service: OrdersService,
    private readonly planSheetsService: PlanSheetsService,
  ) {}

  /**
   * 订单列表。
   * I17 裁定：占位档案（未建档客户·待补 / 未建档产品·待补）相关单据**默认隐藏**；
   * includePlaceholders=1（界面「显示占位档案」开关）或 hasPending=1（补全工作流）时显示。
   */
  @Get()
  findAll(
    @Query('status') status?: OrderStatus,
    @Query('customerId') customerId?: string,
    @Query('kw') kw?: string,
    @Query('hasPending') hasPending?: string,
    @Query('includePlaceholders') includePlaceholders?: string,
  ) {
    return this.service.findAll({
      status,
      customerId: customerId ? Number(customerId) : undefined,
      kw,
      hasPending,
      includePlaceholders,
    });
  }

  /**
   * 落草稿订单（I17）：把识单结果（含 .doc 管线结果）变成草稿订单，缺项逐行/逐单标「待补」。
   * 权限与建单一致（admin / planner）。传统全字段建单仍走 POST /orders（行为不变）。
   */
  @Roles('admin', 'planner')
  @Post('draft')
  createDraft(@Body() dto: CreateDraftOrderDtoBody) {
    return this.service.createDraftFromParse(dto as CreateDraftOrderDto);
  }

  /** 订单确认：草稿 → 已确认，自动生成计划单草稿（I05） */
  /** 取消订单（五态收敛）：仅未投产订单可取消，未开工计划单与未核销应收同步冲销 */
  @Roles('admin', 'planner')
  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.service.cancelOrder(id);
  }

  @Roles('admin', 'planner')
  @Post(':id/confirm')
  confirm(@Param('id', ParseIntPipe) id: number) {
    return this.planSheetsService.confirmOrder(id);
  }

  /** 一键从报价记录补价（I17）：对缺价行取价，命中即写回并清标记，未命中保持待补 */
  @Roles('admin', 'planner')
  @Post(':id/fill-quote-prices')
  fillQuotePrices(@Param('id', ParseIntPipe) id: number) {
    return this.service.fillQuotePrices(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Roles('admin', 'planner')
  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.service.create(dto);
  }

  @Roles('admin', 'planner')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateOrderDto>) {
    return this.service.update(id, dto);
  }

  @Roles('admin', 'planner')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
