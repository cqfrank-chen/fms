import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './index';
import { join } from 'path';

/**
 * 启动时自动执行 migration（幂等，Nest 每次启动跑一次）。
 * migration SQL 目录：源码 <api>/drizzle（tsc 编译后 __dirname=dist/db → 上溯两级）。
 */
export async function runMigrations() {
  const folder = join(__dirname, '..', '..', 'drizzle');
  await migrate(db, { migrationsFolder: folder });
}
