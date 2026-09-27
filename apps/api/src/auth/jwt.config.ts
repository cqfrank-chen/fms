import { randomBytes } from 'node:crypto';

/** 登录态有效期：12 小时（需求指定，登录一次覆盖一个工作日） */
export const JWT_EXPIRES_IN = '12h';

let cachedSecret: string | null = null;

/**
 * JWT 密钥：优先读取环境变量 JWT_SECRET；
 * 未配置时在进程启动时随机生成（48 字节 hex）并打印警告——
 * 此时密钥不落盘，进程重启后全部登录态失效（需重新登录），生产环境请显式配置。
 */
export function jwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  cachedSecret = randomBytes(48).toString('hex');
  console.warn(
    '[auth][警告] 未配置环境变量 JWT_SECRET，已随机生成临时密钥（仅本进程有效，重启后需重新登录）。' +
      '生产环境请在 .env 中设置固定的 JWT_SECRET。',
  );
  return cachedSecret;
}
