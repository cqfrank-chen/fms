import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 根路由：服务名（供探活/人工确认） */
  @Get()
  getServiceName(): string {
    return this.appService.getServiceName();
  }

  /** 健康检查：API + 数据库连通性（首页状态徽标消费）；@Public = 免登录白名单（探活/容器健康检查） */
  @Public()
  @Get('health')
  async health(): Promise<{ status: string; db: string; time: string }> {
    const dbOk = await this.appService.checkDb();
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'up' : 'down',
      time: new Date().toISOString(),
    };
  }
}
