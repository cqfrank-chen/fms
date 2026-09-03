import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CustomersModule } from './customers/customers.module';
import { OperatorsModule } from './operators/operators.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { TestProductsModule } from './test-products/test-products.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TestProductsModule,
    ProductsModule,
    CustomersModule,
    SuppliersModule,
    OperatorsModule,
    OrdersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
