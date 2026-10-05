import { BadRequestException } from '@nestjs/common';

/** 文件体积上限（与 main.ts 的 12mb JSON 上限留出余量） */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * 上传文件 → Buffer + MIME（AI 识单与主数据批量导入共用同一协议）：
 * 入参为 dataURL（data:<mime>;base64,xxx）或纯 base64；解析失败给中文提示，不透出库原始错误。
 */
export function decodeUpload(fileStr: string, fileName?: string): { buffer: Buffer; mime: string; name: string } {
  const m = fileStr.match(/^data:([^;,]*)?(;base64)?,(.*)$/s);
  const mime = (m?.[1] ?? '').trim();
  const base64 = (m ? m[3] : fileStr).replace(/\s/g, '');
  if (!base64) throw new BadRequestException('上传内容为空，请重新选择文件');
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new BadRequestException('上传内容不是合法文件（base64 解析失败），请重新选择文件');
  }
  if (!buffer.length) throw new BadRequestException('上传内容为空，请重新选择文件');
  if (buffer.length > MAX_FILE_BYTES) {
    throw new BadRequestException('文件超过 8MB，请精简表格后重试（或另存为 .csv）');
  }
  return { buffer, mime, name: (fileName ?? '').trim() };
}
