import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AccountingModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
