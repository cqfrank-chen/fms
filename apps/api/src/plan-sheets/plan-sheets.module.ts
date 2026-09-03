import { Module } from '@nestjs/common';
import { PlanSheetsController } from './plan-sheets.controller';
import { PlanSheetsService } from './plan-sheets.service';

@Module({
  controllers: [PlanSheetsController],
  providers: [PlanSheetsService],
  exports: [PlanSheetsService],
})
export class PlanSheetsModule {}
