import { Controller, Get } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  /** 首页看板数据（只读聚合） */
  @Get()
  overview() {
    return this.service.overview();
  }
}
