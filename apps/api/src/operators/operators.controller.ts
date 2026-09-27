import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { OperatorsService } from './operators.service';

export class CreateOperatorDto {
  @IsNotEmpty({ message: '操作人姓名必填' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  boundPc?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

@Controller('operators')
export class OperatorsController {
  constructor(private readonly service: OperatorsService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Roles('admin')
  @Post()
  create(@Body() dto: CreateOperatorDto) {
    return this.service.create(dto);
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateOperatorDto>) {
    return this.service.update(id, dto);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
