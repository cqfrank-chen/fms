import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from './accounting/accounting.module';
import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CustomersModule } from './customers/customers.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { OperatorsModule } from './operators/operators.module';
import { OrdersModule } from './orders/orders.module';
import { PlanSheetsModule } from './plan-sheets/plan-sheets.module';
import { ProductsModule } from './products/products.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { WarehouseModule } from './warehouse/warehouse.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AiModule,
    DashboardModule,
    ProductsModule,
    CustomersModule,
    SuppliersModule,
    OperatorsModule,
    OrdersModule,
    PlanSheetsModule,
    WarehouseModule,
    AccountingModule,
    SchedulingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
