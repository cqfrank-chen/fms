import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TestProductsModule } from './test-products/test-products.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TestProductsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
