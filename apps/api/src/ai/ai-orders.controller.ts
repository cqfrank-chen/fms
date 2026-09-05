import { Body, Controller, HttpException, HttpStatus, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { OrderParserService } from './order-parser.service';

class ParseOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  text?: string;

  @IsOptional()
  @IsString()
  image?: string; // dataURL（data:image/...;base64,...）

  /** 仅 mock 模式（未配 AI_API_KEY）生效：直通 LLM 抽取结果，供验收/离线测试 */
  @IsOptional()
  stub?: Record<string, unknown>;

  @ValidateIf((o: ParseOrderDto) => !o.text && !o.image && !o.stub)
  @IsString({ message: 'text / image / stub 至少提供一个' })
  _atLeastOne?: string;
}

@Controller('ai/orders')
export class AiOrdersController {
  constructor(private readonly parser: OrderParserService) {}

  /** AI 订单解析：文本/图片 → 结构化草稿 + 规则校验 + 低置信标红（确认建单复用 POST /orders） */
  @Post('parse')
  async parse(@Body() dto: ParseOrderDto) {
    try {
      return await this.parser.parseAndResolve({
        text: dto.text,
        image: dto.image,
        stub: dto.stub as never,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('AI_VISION_KEY')) {
        throw new HttpException({ message: msg, code: 'VISION_KEY_MISSING' }, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException({ message: `AI 解析失败：${msg}` }, HttpStatus.BAD_GATEWAY);
    }
  }
}
