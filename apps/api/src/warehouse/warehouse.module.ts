import { Module } from '@nestjs/common';
import {
  IncomingController, InventoryController, OutboundsController, ReceiptsController, StocktakesController,
} from './warehouse.controller';
import { WarehouseService } from './warehouse.service';

@Module({
  controllers: [
    InventoryController,
    ReceiptsController,
    OutboundsController,
    IncomingController,
    StocktakesController,
  ],
  providers: [WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
