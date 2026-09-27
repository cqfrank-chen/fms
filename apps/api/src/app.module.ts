import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from './accounting/accounting.module';
import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CustomersModule } from './customers/customers.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MasterDataModule } from './master-data/master-data.module';
import { OperatorsModule } from './operators/operators.module';
import { OrdersModule } from './orders/orders.module';
import { PlanSheetsModule } from './plan-sheets/plan-sheets.module';
import { ProductsModule } from './products/products.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { OperatorInterceptor } from './common/operator.interceptor';

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
    MasterDataModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_INTERCEPTOR, useClass: OperatorInterceptor }],
})
export class AppModule {}
