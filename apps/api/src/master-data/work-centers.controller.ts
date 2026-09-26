import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { MasterDataService } from './master-data.service';

class CreateWorkCenterDto {
  @IsNotEmpty({ message: '工作中心名称必填' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsInt({ message: '可并行设备数须为整数' })
  @Min(1, { message: '可并行设备数至少为 1' })
  @Max(99, { message: '可并行设备数不能超过 99' })
  machines?: number;

  @IsOptional()
  @IsInt({ message: '排序须为整数' })
  @Min(0)
  sortOrder?: number;
}

class UpdateWorkCenterDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt({ message: '可并行设备数须为整数' })
  @Min(1, { message: '可并行设备数至少为 1' })
  @Max(99, { message: '可并行设备数不能超过 99' })
  machines?: number;

  @IsOptional()
  @IsInt({ message: '排序须为整数' })
  @Min(0)
  sortOrder?: number;
}

@Controller('work-centers')
export class WorkCentersController {
  constructor(private readonly svc: MasterDataService) {}

  /** 工作中心（泳道）列表（含工序数） */
  @Get()
  list() {
    return this.svc.listWorkCenters();
  }

  @Post()
  create(@Body() dto: CreateWorkCenterDto) {
    return this.svc.createWorkCenter(dto);
  }

  @Patch(':key')
  update(@Param('key') key: string, @Body() dto: UpdateWorkCenterDto) {
    return this.svc.updateWorkCenter(key, dto);
  }

  /** 删除泳道：仍挂工序或有计划行时拒绝 */
  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.svc.removeWorkCenter(key);
  }
}
