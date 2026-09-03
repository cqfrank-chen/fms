import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PackTemplatesController } from './pack-templates.controller';
import { PackTemplatesService } from './pack-templates.service';

@Module({
  controllers: [OrdersController, PackTemplatesController],
  providers: [OrdersService, PackTemplatesService],
})
export class OrdersModule {}
