import {
  Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { readStickerImageStream } from './sticker-storage';
import { StickersService } from './stickers.service';
import type { StickerAdjustInput, StickerInput } from './stickers.service';

/**
 * 不干胶库存（I18）
 * ------------------------------------------------------------------
 * 权限（与权限矩阵一致，不干胶属**仓储**）：写操作限 admin + warehouse；
 * 读操作（列表/详情/取图/流水）不加 @Roles → 任意已登录角色可用。
 * 上传协议沿用既有约定：file = dataURL(data:<mime>;base64,…) 或纯 base64 + fileName。
 */

class RecognizeDto {
  /** 上传图片：dataURL（data:image/png;base64,…）或纯 base64 */
  @IsNotEmpty({ message: '请上传不干胶图片（file 必填）' })
  @IsString()
  file: string;

  @IsOptional() @IsString() @MaxLength(255) fileName?: string;

  /** 识别线索：所属客户/文件夹名（图上看不出客户时直接采用，作为建议值） */
  @IsOptional() @IsString() @MaxLength(200) customer?: string;
}

class StickerCreateDto implements StickerInput {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) brand?: string;
  @IsOptional() @IsString() @MaxLength(200) style?: string;
  @IsOptional() @IsString() @MaxLength(200) sizeSpec?: string;
  @IsOptional() @IsInt({ message: '库存数量须为整数' }) @Min(0, { message: '库存数量不能为负' }) qty?: number;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @IsString() @MaxLength(200) customer?: string;
  @IsOptional() @IsString() @MaxLength(2000) remark?: string;
  @IsOptional() @IsString() @MaxLength(8000) rawText?: string;
  /** recognize 返回的图片相对路径（与 file 二选一） */
  @IsOptional() @IsString() @MaxLength(500) imagePath?: string;
  /** 上传图片（与 imagePath 二选一；同时给以 file 为准） */
  @IsOptional() @IsString() file?: string;
  @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  /** 识图不可用时的说明（写进备注留痕） */
  @IsOptional() @IsString() @MaxLength(500) aiNote?: string;
}

class StickerUpdateDto extends StickerCreateDto {}

class StickerAdjustDto implements StickerAdjustInput {
  /** 调整方向：in 入库 / out 领用（与 qty 搭配） */
  @IsOptional() @IsIn(['in', 'out'], { message: '调整方向须为 in（入库）或 out（领用）' }) kind?: string;
  /** 本次数量（正整数；与 kind 搭配） */
  @IsOptional() @IsInt({ message: '数量须为整数' }) @Min(1, { message: '数量至少为 1' }) qty?: number;
  /** 或直接给带符号增量（正=入库、负=领用；与 kind/qty 二选一） */
  @IsOptional() @IsInt({ message: '调整数量须为整数' }) delta?: number;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

@Controller('stickers')
export class StickersController {
  constructor(private readonly svc: StickersService) {}

  /** 列表：关键词 / 品牌 / 客户 + 分页（任意已登录角色） */
  @Get()
  findAll(
    @Query('kw') kw?: string,
    @Query('brand') brand?: string,
    @Query('customer') customer?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.findAll({
      kw: kw?.trim() || undefined,
      brand: brand?.trim() || undefined,
      customer: customer?.trim() || undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** 品牌候选（筛选下拉；必须声明在 :id 之前，否则会被当成 id） */
  @Get('brands')
  brands() {
    return this.svc.brands();
  }

  /**
   * 上传识别（**不写库**）：图片 → 视觉通道 → 建议标题/品牌/样式/规格/备注 + rawText。
   * 识图 Key 未配置或调用失败时返回 200 + ok:false + 中文提示（不是 500），并附已落盘的 imagePath，
   * 用户可手工填写后直接 POST /stickers 建档。
   */
  @Roles('admin', 'warehouse')
  @HttpCode(200) // 只识别不写库：语义是查询，不是新建 → 200
  @Post('recognize')
  recognize(@Body() dto: RecognizeDto) {
    return this.svc.recognize(dto);
  }

  /** 建档：图片 + 已确认字段 */
  @Roles('admin', 'warehouse')
  @Post()
  create(@Body() dto: StickerCreateDto) {
    return this.svc.create(dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  /** 取图（登录态校验后返回文件流；不暴露静态目录） */
  @Get(':id/image')
  async image(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response) {
    const f = await this.svc.imageFile(id);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.bytes));
    // 私有缓存：图片内容不变（换图会生成新路径，URL 里的 id 不变但内容变了 → 短缓存）
    res.setHeader('Cache-Control', 'private, max-age=60');
    return new StreamableFile(readStickerImageStream(f.relPath));
  }

  /** 数量流水（入库/领用留痕） */
  @Get(':id/adjustments')
  adjustments(@Param('id', ParseIntPipe) id: number, @Query('limit') limit?: string) {
    return this.svc.adjustments(id, limit ? Number(limit) : 50);
  }

  /** 编辑字段 */
  @Roles('admin', 'warehouse')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: StickerUpdateDto) {
    return this.svc.update(id, dto);
  }

  /** 数量调整：入库/领用，正负均可（写流水 + 操作人留痕） */
  @Roles('admin', 'warehouse')
  @HttpCode(200) // 动作接口（非新建资源）→ 200
  @Post(':id/adjust')
  adjust(@Param('id', ParseIntPipe) id: number, @Body() dto: StickerAdjustDto) {
    return this.svc.adjust(id, dto);
  }
}
