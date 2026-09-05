import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { SchedulingService } from './scheduling.service';

class ScheduleDto {
  @IsString()
  wcKey: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '开始日须为 YYYY-MM-DD' })
  startDate: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  coverDays?: number | null;
}

@Controller('scheduling')
export class SchedulingController {
  constructor(private readonly svc: SchedulingService) {}

  @Get('work-centers')
  workCenters() { return this.svc.listWorkCenters(); }

  @Get('processes')
  processes() { return this.svc.listProcesses(); }

  @Get('tasks')
  tasks() { return this.svc.listTasks(); }

  @Get('verify')
  verify(
    @Query('lineId', ParseIntPipe) lineId: number,
    @Query('wcKey') wcKey: string,
    @Query('startDate') startDate: string,
  ) {
    return this.svc.verify(lineId, wcKey, startDate);
  }

  @Post('plan-lines/:lineId/schedule')
  schedule(@Param('lineId', ParseIntPipe) lineId: number, @Body() dto: ScheduleDto) {
    return this.svc.scheduleLine(lineId, dto);
  }

  @Delete('plan-lines/:lineId/schedule')
  unschedule(@Param('lineId', ParseIntPipe) lineId: number) {
    return this.svc.unscheduleLine(lineId);
  }
}