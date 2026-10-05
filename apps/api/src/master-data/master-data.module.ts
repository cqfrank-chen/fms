import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { MasterDataService } from './master-data.service';
import { MasterImportController } from './master-import.controller';
import { MasterImportService } from './master-import.service';
import { ProcessesController } from './processes.controller';
import { WorkCentersController } from './work-centers.controller';

@Module({
  // AiModule 提供 TableParserService（.xls/.xlsx/.csv 解析）与表头映射，主数据导入直接复用，不另起解析器
  imports: [AiModule],
  controllers: [ProcessesController, WorkCentersController, MasterImportController],
  providers: [MasterDataService, MasterImportService],
  exports: [MasterDataService],
})
export class MasterDataModule {}
