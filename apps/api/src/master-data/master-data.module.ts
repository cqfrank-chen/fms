import { Module } from '@nestjs/common';
import { MasterDataService } from './master-data.service';
import { ProcessesController } from './processes.controller';
import { WorkCentersController } from './work-centers.controller';

@Module({
  controllers: [ProcessesController, WorkCentersController],
  providers: [MasterDataService],
  exports: [MasterDataService],
})
export class MasterDataModule {}
