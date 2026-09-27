import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { MasterDataService } from './master-data.service';

class CreateProcessDto {
  @IsNotEmpty({ message: '工序名必填' })
  @IsString()
  name: string;

  @IsNotEmpty({ message: '所属工作中心必填' })
  @IsString()
  wcKey: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsInt({ message: '排序须为整数' })
  @Min(0)
  sortOrder?: number;
}

class UpdateProcessDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  wcKey?: string;

  @IsOptional()
  @IsInt({ message: '排序须为整数' })
  @Min(0)
  sortOrder?: number;
}

@Controller('processes')
export class ProcessesController {
  constructor(private readonly svc: MasterDataService) {}

  /** 工序字典（含所属泳道名与使用该工序的产品数） */
  @Get()
  list() {
    return this.svc.listProcesses();
  }

  @Roles('admin', 'planner')
  @Post()
  create(@Body() dto: CreateProcessDto) {
    return this.svc.createProcess(dto);
  }

  @Roles('admin', 'planner')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProcessDto) {
    return this.svc.updateProcess(id, dto);
  }

  /** 删除工序：被产品工艺路线引用时拒绝并说明数量 */
  @Roles('admin', 'planner')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.removeProcess(id);
  }
}
