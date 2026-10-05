import { Module } from '@nestjs/common';
import { TableParserService } from '../ai/table-parser.service';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

/**
 * 报价记录（I17）。
 * 说明：批量导入要复用 AI 识单的表格解析（.xls/.xlsx/.csv + 表头映射），
 * 这里**直接在本模块提供 TableParserService**（无状态、无构造依赖），
 * 避免 QuotesModule → AiModule → QuotesModule 的循环依赖。
 */
@Module({
  controllers: [QuotesController],
  providers: [QuotesService, TableParserService],
  exports: [QuotesService],
})
export class QuotesModule {}
