import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/decorators';
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

class CreateManualReceiptDto {
  @IsInt({ message: '产品 ID 须为整数' })
  productId: number;

  @IsInt({ message: '入库数量须为整数' })
  @Min(1, { message: '入库数量至少为 1' })
  quantity: number;

  @IsOptional()
  @IsString()
  batchNo?: string;

  @IsOptional()
  @IsString()
  note?: string;
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
  @Roles('admin', 'warehouse')
  @Post('manual') createManual(@Body() dto: CreateManualReceiptDto) { return this.svc.createManualReceipt(dto); }
  @Roles('admin', 'warehouse')
  @Post(':id/confirm') confirm(@Param('id', ParseIntPipe) id: number) { return this.svc.confirmReceipt(id); }
  @Roles('admin', 'warehouse')
  @Post(':id/void') void(@Param('id', ParseIntPipe) id: number) { return this.svc.voidReceipt(id); }
}

@Controller('outbounds')
export class OutboundsController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.outboundsList(); }
  @Roles('admin', 'warehouse')
  @Post() create(@Body() dto: CreateOutboundDto) { return this.svc.createOutbound(dto); }
  @Roles('admin', 'warehouse')
  @Post(':id/submit') submit(@Param('id', ParseIntPipe) id: number) { return this.svc.submitOutbound(id); }
  @Roles('admin', 'warehouse')
  @Post(':id/oqc-pass') oqcPass(@Param('id', ParseIntPipe) id: number) { return this.svc.oqcPass(id); }
  @Roles('admin', 'warehouse')
  @Post(':id/void') void(@Param('id', ParseIntPipe) id: number) { return this.svc.voidOutbound(id); }
  @Roles('admin', 'warehouse')
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.removeDraft(id); }
}

@Controller('incoming-goods')
export class IncomingController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.incomingList(); }
  @Roles('admin', 'warehouse')
  @Post() create(@Body() dto: CreateIncomingDto) { return this.svc.createIncoming(dto); }
  @Roles('admin', 'warehouse')
  @Post(':id/void') void(@Param('id', ParseIntPipe) id: number) { return this.svc.voidIncoming(id); }
}

@Controller('stocktakes')
export class StocktakesController {
  constructor(private readonly svc: WarehouseService) {}
  @Get() list() { return this.svc.stocktakesList(); }
  @Roles('admin', 'warehouse')
  @Post() create(@Body() dto: CreateStocktakeDto) { return this.svc.createStocktake(dto); }
  @Roles('admin', 'warehouse')
  @Post(':id/confirm') confirm(@Param('id', ParseIntPipe) id: number) { return this.svc.confirmStocktake(id); }
  @Roles('admin', 'warehouse')
  @Post(':id/void') void(@Param('id', ParseIntPipe) id: number) { return this.svc.voidStocktake(id); }
}
