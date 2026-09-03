import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // generate 不需要连库；push/migrate 才需要（I01 用 generate + 启动时 migrate）
    url: process.env.DATABASE_URL ?? 'postgres://fms:fms@localhost:5432/fms',
  },
});
