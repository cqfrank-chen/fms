import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AiConfigService } from './ai-config.service';
import { AiController } from './ai.controller';
import { AiFeedbackController } from './ai-feedback.controller';
import { AiOrdersController } from './ai-orders.controller';
import { LlmGatewayService } from './llm-gateway.service';
import { OrderParserService } from './order-parser.service';
import { QaService } from './qa.service';
import { TableParserService } from './table-parser.service';
import { ReportSummaryService } from './report-summary.service';
import { RuleAlertService } from './rule-alerts.service';

@Module({
  imports: [SchedulingModule, AccountingModule], // 复用排期 overdue 与利润取数口径
  controllers: [AiController, AiOrdersController, AiFeedbackController],
  providers: [AiConfigService, LlmGatewayService, OrderParserService, TableParserService, QaService, ReportSummaryService, RuleAlertService],
  exports: [LlmGatewayService, OrderParserService],
})
export class AiModule {}
