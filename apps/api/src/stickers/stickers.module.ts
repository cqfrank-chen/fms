import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { StickersController } from './stickers.controller';
import { StickersService } from './stickers.service';

/** 不干胶库存（I18）：图片识别建档 + 查询 + 数量维护；视觉通道复用 AiModule 的 LLM 网关 */
@Module({
  imports: [AiModule],
  controllers: [StickersController],
  providers: [StickersService],
})
export class StickersModule {}
