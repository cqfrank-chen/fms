import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Roles } from '../auth/decorators';
import { decodeUpload } from '../common/upload';
import { IMPORT_MODES, IMPORT_TARGETS, MasterImportService } from './master-import.service';
import type { ImportMode, ImportTarget } from './master-import.service';

/**
 * 主数据批量导入（客户 / 产品）：上传 → 预览校验（不写库）→ 确认导入。
 * 权限：写操作（preview / commit）与既有主数据维护一致，限 admin / planner（见 auth/permissions.ts 矩阵）；
 * 模板下载是 GET，任意已登录角色可用（读操作不设 @Roles）。
 * 上传协议与 AI 识单完全一致：file = dataURL(data:<mime>;base64,…) 或纯 base64 + fileName。
 */
class ImportFileDto {
  @IsIn(IMPORT_TARGETS, { message: 'target 须为 customers（客户）或 products（产品）' })
  target: ImportTarget;

  @IsOptional()
  @IsIn(IMPORT_MODES, { message: 'mode 须为 insert-only（仅新增）或 upsert（新增或更新）' })
  mode?: ImportMode;

  /** 上传文件：dataURL 或纯 base64（与 AI 识单上传同一协议） */
  @IsNotEmpty({ message: 'file（上传文件内容）必填' })
  @IsString()
  file: string;

  /** 原始文件名（.xls/.xlsx/.csv；实际类型按 magic bytes 判定） */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

@Controller('master-data/import')
export class MasterImportController {
  constructor(private readonly svc: MasterImportService) {}

  /** 下载导入模板（CSV，中文表头 + 示例行；Excel 可直接打开） */
  @Get('template')
  template(@Query('target') target: string, @Res() res: Response) {
    const { name, csv } = this.svc.template(target);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name));
    res.send('\uFEFF' + csv);
  }

  /** 解析预览 + 逐行校验（只读，不写库）：返回 新增/更新/跳过/错误 分类与原因 */
  @Roles('admin', 'planner')
  @Post('preview')
  preview(@Body() dto: ImportFileDto) {
    const up = decodeUpload(dto.file, dto.fileName);
    return this.svc.preview({ target: dto.target, mode: dto.mode, buffer: up.buffer, fileName: up.name, mimeType: up.mime });
  }

  /** 确认导入：先按同一套规则重新解析校验（失败即中止、不发写），再逐行事务写库 */
  @Roles('admin', 'planner')
  @Post('commit')
  commit(@Body() dto: ImportFileDto) {
    const up = decodeUpload(dto.file, dto.fileName);
    return this.svc.commit({ target: dto.target, mode: dto.mode, buffer: up.buffer, fileName: up.name, mimeType: up.mime });
  }
}
