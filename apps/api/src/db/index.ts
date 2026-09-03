import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const pool = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'fms',
  password: process.env.DB_PASSWORD ?? 'fms',
  database: process.env.DB_NAME ?? 'fms',
});

export const db = drizzle(pool, { schema });
