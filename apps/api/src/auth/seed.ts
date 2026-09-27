import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { hashPassword } from './auth.service';

/** 默认管理员（首次启动写入；已存在则跳过，不覆盖已修改过的密码） */
export const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'Fms@2026',
  displayName: '系统管理员',
  role: 'admin' as const,
};

/**
 * 启动时种子：插入默认管理员 admin / Fms@2026（bcryptjs 哈希，不存明文）。
 * 幂等：username 已存在直接返回，重启不会重置密码。
 */
export async function seedDefaultAdmin(): Promise<void> {
  const [exist] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, DEFAULT_ADMIN.username))
    .limit(1);
  if (exist) return;
  const passwordHash = await hashPassword(DEFAULT_ADMIN.password);
  await db
    .insert(users)
    .values({
      username: DEFAULT_ADMIN.username,
      passwordHash,
      displayName: DEFAULT_ADMIN.displayName,
      role: DEFAULT_ADMIN.role,
    })
    .onConflictDoNothing();
  console.log('[auth] 已创建默认管理员 admin（初始密码 Fms@2026），请登录后立即修改密码。');
}
