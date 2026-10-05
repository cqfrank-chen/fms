import { BadRequestException } from '@nestjs/common';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';

/**
 * 不干胶图片存储（挂载卷目录，**不入库 base64**）
 * ------------------------------------------------------------------
 * 方案：图片落盘到「挂载卷目录」，库里只存**相对路径**（stickers.image_path）。
 *   · 容器里：STICKER_UPLOAD_DIR=/app/uploads/stickers，docker-compose 把 ./uploads 挂到 /app/uploads，
 *     宿主可直接备份/清理，卷不随镜像升级丢失（见 docker-compose.yml 的 app.volumes）；
 *   · 本地开发：未配 STICKER_UPLOAD_DIR 且没有 /app 时，回退到 <进程工作目录>/uploads/stickers；
 *   · 目录按 YYYY/MM 分层，避免单目录堆几十万文件；
 *   · 读取一律走 resolveStickerImagePath()，做**目录穿越防护**（路径拼接后必须仍在根目录内）。
 * 对外取图走 GET /api/stickers/:id/image（登录态校验后返回文件流），不直接暴露静态目录。
 */

/** 容器内默认目录（与 docker-compose 的卷挂载点一致） */
export const CONTAINER_UPLOAD_DIR = '/app/uploads/stickers';

/** 允许的图片扩展名（与视觉通道支持的一致） */
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

/** MIME → 扩展名（优先按内容 MIME 定名，扩展名写错也不会存成怪文件） */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
  'image/tiff': '.tif',
};

/** 扩展名 → MIME（响应头用） */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/** 图片存放根目录（可用 STICKER_UPLOAD_DIR 覆盖；每次调用实时读取，便于测试注入） */
export function stickerUploadDir(): string {
  const env = (process.env.STICKER_UPLOAD_DIR ?? '').trim();
  if (env) return resolve(env);
  // 容器内：/app 存在 → 用挂载卷默认路径；本地开发 → 进程工作目录下的 uploads/stickers
  if (process.platform !== 'win32' && existsSync('/app')) return CONTAINER_UPLOAD_DIR;
  return resolve(process.cwd(), 'uploads', 'stickers');
}

/** 由 MIME（优先）与原始文件名（兜底）决定扩展名 */
export function imageExtFor(mime: string, origName?: string): string {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  const e = extname(origName ?? '').toLowerCase();
  if (ALLOWED_EXT.has(e)) return e === '.jpeg' ? '.jpg' : e === '.tiff' ? '.tif' : e;
  return '.jpg';
}

/** 是图片 MIME 或图片扩展名 */
export function looksLikeImage(mime: string, name?: string): boolean {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('image/')) return true;
  return ALLOWED_EXT.has(extname(name ?? '').toLowerCase());
}

export interface SavedImage {
  /** 相对路径（入库值），形如 2026/10/3f2a....jpg */
  relPath: string;
  /** 绝对路径（落盘位置） */
  absPath: string;
  bytes: number;
  mime: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 保存图片到挂载卷目录。文件名用 UUID（不采信用户文件名，避免注入与重名覆盖），
 * 目录按年/月分层；返回相对路径供入库。
 */
export function saveStickerImage(buffer: Buffer, mime: string, origName?: string, now: Date = new Date()): SavedImage {
  if (!buffer?.length) throw new BadRequestException('上传内容为空，请重新选择图片');
  const ext = imageExtFor(mime, origName);
  const relDir = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}`;
  const absDir = join(stickerUploadDir(), relDir);
  mkdirSync(absDir, { recursive: true });
  const fileName = `${randomUUID()}${ext}`;
  const absPath = join(absDir, fileName);
  writeFileSync(absPath, buffer);
  const normMime = (MIME_BY_EXT[ext] ?? (mime || 'image/jpeg')).split(';')[0].trim();
  return { relPath: `${relDir}/${fileName}`, absPath, bytes: buffer.length, mime: normMime };
}

/**
 * 相对路径 → 绝对路径（**目录穿越防护**）：
 * 拒绝空值、绝对路径、含 '..' 的片段，且拼接后必须仍位于根目录之内。
 */
export function resolveStickerImagePath(relPath: string): string {
  const rel = (relPath ?? '').trim().replace(/\\/g, '/');
  if (!rel) throw new BadRequestException('该不干胶记录没有图片');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new BadRequestException('图片路径非法');
  const root = stickerUploadDir();
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new BadRequestException('图片路径非法（越出上传目录）');
  return abs;
}

/** 图片是否已落盘（建档/查询时校验图片可用性） */
export function stickerImageExists(relPath?: string | null): boolean {
  if (!relPath) return false;
  try {
    return existsSync(resolveStickerImagePath(relPath));
  } catch {
    return false;
  }
}

/** 图片 MIME（按扩展名推断，未知按 jpeg） */
export function mimeForImagePath(relPath: string): string {
  return MIME_BY_EXT[extname(relPath).toLowerCase()] ?? 'image/jpeg';
}

/** 图片字节数（不存在返回 null） */
export function imageBytes(relPath: string): number | null {
  try {
    const abs = resolveStickerImagePath(relPath);
    if (!existsSync(abs)) return null;
    return statSync(abs).size;
  } catch {
    return null;
  }
}

/** 读文件流（controller 用；调用前先用 stickerImageExists 校验） */
export function readStickerImageStream(relPath: string) {
  return createReadStream(resolveStickerImagePath(relPath));
}
