import { Controller, Get, Post } from '@nestjs/common';
import { UpdateService } from './update.service';

/** 自动更新（I13）：版本比对 / 下载 / 提交更新请求 */
@Controller('update')
export class UpdateController {
  constructor(private readonly svc: UpdateService) {}

  @Get('status')
  status() { return this.svc.status(); }

  @Post('download')
  download() { return this.svc.download(); }

  @Post('apply')
  apply() { return this.svc.apply(); }
}
