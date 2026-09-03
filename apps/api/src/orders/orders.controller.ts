import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional,
  IsString, Min, ValidateNested,
} from 'class-validator';
import { CURRENCIES } from '../db/schema';
import type { Currency, OrderStatus } from '../db/schema';
import { OrdersService } from './orders.service';

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

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  findAll(
    @Query('status') status?: OrderStatus,
    @Query('customerId') customerId?: string,
    @Query('kw') kw?: string,
  ) {
    return this.service.findAll({
      status,
      customerId: customerId ? Number(customerId) : undefined,
      kw,
    });
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateOrderDto>) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
