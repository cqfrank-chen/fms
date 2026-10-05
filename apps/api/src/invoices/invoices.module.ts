import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/** 开票模块（I16）：发票主数据 + 订单关联 + 开票数目统计；与收款/核销互不依赖（只读聚合收款进度） */
@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
