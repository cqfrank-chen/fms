import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from './accounting/accounting.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CustomersModule } from './customers/customers.module';
import { InvoicesModule } from './invoices/invoices.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MasterDataModule } from './master-data/master-data.module';
import { OperatorsModule } from './operators/operators.module';
import { OrdersModule } from './orders/orders.module';
import { PlanSheetsModule } from './plan-sheets/plan-sheets.module';
import { ProductsModule } from './products/products.module';
import { QuotesModule } from './quotes/quotes.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { UpdateModule } from './update/update.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { OperatorInterceptor } from './common/operator.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    AiModule,
    DashboardModule,
    ProductsModule,
    QuotesModule,
    CustomersModule,
    SuppliersModule,
    OperatorsModule,
    OrdersModule,
    PlanSheetsModule,
    WarehouseModule,
    AccountingModule,
    InvoicesModule,
    SchedulingModule,
    MasterDataModule,
    UpdateModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // 全局登录守卫：默认所有接口都需登录（@Public 白名单例外：GET /api/health、POST /api/auth/login）
    { provide: APP_GUARD, useClass: AuthGuard },
    // 全局角色守卫：@Roles 限定写操作；读操作不加注解 = 所有登录用户可用（权限矩阵见 auth/permissions.ts）
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: OperatorInterceptor },
  ],
})
export class AppModule {}
