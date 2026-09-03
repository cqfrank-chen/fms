import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PackTemplatesController } from './pack-templates.controller';
import { PackTemplatesService } from './pack-templates.service';
import { PlanSheetsModule } from '../plan-sheets/plan-sheets.module';

@Module({
  imports: [PlanSheetsModule],
  controllers: [OrdersController, PackTemplatesController],
  providers: [OrdersService, PackTemplatesService],
})
export class OrdersModule {}
