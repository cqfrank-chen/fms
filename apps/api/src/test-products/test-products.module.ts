import { Module } from '@nestjs/common';
import { TestProductsController } from './test-products.controller';
import { TestProductsService } from './test-products.service';

@Module({
  controllers: [TestProductsController],
  providers: [TestProductsService],
})
export class TestProductsModule {}
