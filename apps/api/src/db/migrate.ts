import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'path';
import { db } from './index';
import { PENDING_PRODUCT_NAME } from './schema';

/**
 * 启动时自动执行 migration（幂等，Nest 每次启动跑一次）。
 * migration SQL 目录：源码 <api>/drizzle（tsc 编译后 __dirname=dist/db → 上溯两级）。
 */
export async function runMigrations() {
  const folder = join(__dirname, '..', '..', 'drizzle');
  await migrate(db, { migrationsFolder: folder });
  await applyDataFixes();
}

/**
 * 迁移后的**幂等数据修正**（I17 甲方裁定）。
 * ------------------------------------------------------------------
 * 为什么放在这里而不是写进 drizzle/*.sql：
 *   drizzle 的 pg migrator 把「本轮所有未执行的迁移」放在**同一个事务**里跑，
 *   而 PostgreSQL 不允许在同一事务里使用刚 ADD VALUE 的枚举值
 *   （报错：unsafe use of new value ... of enum type ...）。
 *   因此「新增枚举值」（0022，纯 DDL，只新增）与「用新枚举值刷历史数据」必须分成
 *   两次事务 —— 这里在 migrate() 提交之后执行，天然是独立事务，且可反复执行。
 *
 * 修正内容（全部幂等、只影响本轮裁定的目标数据，不碰其它行）：
 *   ① 占位产品「（未建档产品·待补）」的类型：从借用的 uk_acetylene 改为中立值 'tbd'（待定）；
 *   ② 报价记录币种归一：历史/异常写入的 RMB / 人民币 / ￥ / ¥ 等一律归一到 CNY。
 *
 * 失败只记日志、不阻断启动：迁移本身已经成功，数据修正可下次启动重试。
 */
async function applyDataFixes(): Promise<void> {
  // ① 占位产品类型 → 待定（tbd）
  try {
    const r = await db.execute(sql`
      update products set type = 'tbd', updated_at = now()
      where name = ${PENDING_PRODUCT_NAME} and type::text <> 'tbd'
    `);
    const n = (r as unknown as { rowCount?: number }).rowCount ?? 0;
    if (n > 0) console.log('[migrate] 数据修正：占位产品类型改为「待定」共 ' + n + ' 行');
  } catch (e) {
    console.warn('[migrate] 数据修正①失败（占位产品类型改待定）：' + (e as Error).message);
  }

  // ② 报价记录币种归一 → CNY
  try {
    const r = await db.execute(sql`
      update product_quotes set currency = 'CNY', updated_at = now()
      where currency is null or upper(btrim(currency)) not in ('CNY', 'USD')
    `);
    const n = (r as unknown as { rowCount?: number }).rowCount ?? 0;
    if (n > 0) console.log('[migrate] 数据修正：报价记录币种归一到 CNY 共 ' + n + ' 行');
  } catch (e) {
    console.warn('[migrate] 数据修正②失败（报价币种归一到 CNY）：' + (e as Error).message);
  }
}
