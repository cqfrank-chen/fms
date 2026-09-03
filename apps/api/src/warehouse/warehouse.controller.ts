import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { WarehouseService } from './warehouse.service';

class OutboundLineDto {
  @IsInt({ message: '订单行 ID 须为整数' })
  orderLineId: number;

  @IsInt({ message: '出库数量须为整数' })
  @Min(1, { message: '出库数量至少为 1' })
  quantity: number;
}

class CreateOutboundDto {
  @IsInt({ message: '订单 ID 须为整数' })
  orderId: number;

  @IsIn(['pending', 'exempt'], { message: 'OQC 模式须为 pending(待检) 或 exempt(免检)' })
  oqc: 'pending' | 'exempt';

  @IsArray()
  @ArrayMinSize(1, { message: '至少一个出库行' })
  @ValidateNested({ each: true })
  @Type(() => OutboundLineDto)
  lines: OutboundLineDto[];
}

class CreateIncomingDto {
  @IsInt({ message: '供应商 ID 须为整数' })
  supplierId: number;

  @IsNotEmpty({ message: '物料名必填' })
  materialName: string;

  @IsInt({ message: '数量须为整数' })
  @Min(1, { message: '数量至少为 1' })
  quantity: number;

  @IsNumber({}, { message: '金额须为数字' })
  @Min(0.01, { message: '金额须为正数' })
  amount: number;

  @IsOptional()
  @IsString()
  batchNo?: string;
}

class CreateStocktakeDto {
  @IsInt({ message: '产品 ID 须为整数' })
  productId: number;

  @IsNotEmpty({ message: '批次号必填' })
  batchNo: string;

  @IsInt({ message: '实盘数须为整数' })
  @Min(0, { message: '实盘数不能为负' })
  actualQty: number;
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.inventoryList(); }
}

@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.receipts(); }
  @Post(':id/confirm') confirm(@Param('id', ParseIntPipe) id: number) { return this.svc.confirmReceipt(id); }
  @Post(':id/void') void(@Param('id', ParseIntPipe) id: number) { return this.svc.voidReceipt(id); }
}

@Controller('outbounds')
export class OutboundsController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.outboundsList(); }
  @Post() create(@Body() dto: CreateOutboundDto) { return this.svc.createOutbound(dto); }
  @Post(':id/submit') submit(@Param('id', ParseIntPipe) id: number) { return this.svc.submitOutbound(id); }
  @Post(':id/oqc-pass') oqcPass(@Param('id', ParseIntPipe) id: number) { return this.svc.oqcPass(id); }
  @Post(':id/void') void(@Param('id', ParseIntPipe) id: number) { return this.svc.voidOutbound(id); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.removeDraft(id); }
}

@Controller('incoming-goods')
export class IncomingController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.incomingList(); }
  @Post() create(@Body() dto: CreateIncomingDto) { return this.svc.createIncoming(dto); }
}

@Controller('stocktakes')
export class StocktakesController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.stocktakesList(); }
  @Post() create(@Body() dto: CreateStocktakeDto) { return this.svc.createStocktake(dto); }
  @Post(':id/confirm') confirm(@Param('id', ParseIntPipe) id: number) { return this.svc.confirmStocktake(id); }
}
