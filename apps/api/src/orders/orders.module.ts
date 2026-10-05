import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PackTemplatesController } from './pack-templates.controller';
import { PackTemplatesService } from './pack-templates.service';
import { PlanSheetsModule } from '../plan-sheets/plan-sheets.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { QuotesModule } from '../quotes/quotes.module';

@Module({
  // InvoicesModule 只读聚合：给订单列表/详情挂「已开票/未开票」（不改订单本身逻辑）
  // QuotesModule：落草稿后「一键从报价取价」补全缺价行（I17）
  imports: [PlanSheetsModule, InvoicesModule, QuotesModule],
  controllers: [OrdersController, PackTemplatesController],
  providers: [OrdersService, PackTemplatesService],
})
export class OrdersModule {}
