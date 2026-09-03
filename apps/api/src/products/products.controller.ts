import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { PRODUCT_TYPES } from '../db/schema';
import type { ProductType } from '../db/schema';
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

@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateProductDto>) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
