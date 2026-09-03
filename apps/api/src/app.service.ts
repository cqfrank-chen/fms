import { Injectable, Logger } from '@nestjs/common';
import { pool } from './db';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  getServiceName(): string {
    return 'FMS · 工厂管理系统 API';
  }

  /** 数据库连通性探针（select 1，失败不抛错只记日志） */
  async checkDb(): Promise<boolean> {
    try {
      await pool.query('select 1');
      return true;
    } catch (e) {
      this.logger.warn(`health db probe failed: ${(e as Error).message}`);
      return false;
    }
  }
}
