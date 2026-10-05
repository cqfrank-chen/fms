import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { QuotesModule } from '../quotes/quotes.module';
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
  // SchedulingModule / AccountingModule：复用排期 overdue 与利润取数口径
  // QuotesModule：识单缺价时按报价记录补价（I17，取价规则与 /api/quotes/lookup 同一实现）
  imports: [SchedulingModule, AccountingModule, QuotesModule],
  controllers: [AiController, AiOrdersController, AiFeedbackController],
  providers: [AiConfigService, LlmGatewayService, OrderParserService, TableParserService, QaService, ReportSummaryService, RuleAlertService],
  // TableParserService 导出给主数据批量导入复用（同一套 .xls/.xlsx/csv 解析与表头规则）
  exports: [LlmGatewayService, OrderParserService, TableParserService],
})
export class AiModule {}
