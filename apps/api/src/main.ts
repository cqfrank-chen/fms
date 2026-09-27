import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import { AppModule } from './app.module';
import { runMigrations } from './db/migrate';
import { seedDefaultAdmin } from './auth/seed';
import { jwtSecret } from './auth/jwt.config';

async function bootstrap() {
  // 启动时自动建表/迁移（postgres 就绪后幂等执行）
  await runMigrations();
  // 初始管理员种子（admin / Fms@2026，已存在则跳过）
  await seedDefaultAdmin();
  // 登录密钥初始化：未配置 JWT_SECRET 时在启动阶段随机生成并打印警告（不落盘，重启后需重新登录）
  jwtSecret();

  // AI 图片订单解析：dataURL 可能达数 MB，关默认 100kb json 解析，挂 12mb 上限
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(express.json({ limit: '12mb' }));
  app.setGlobalPrefix('api'); // 统一 /api 前缀（nginx 反代 /api → app）
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
  console.log(`API listening on http://localhost:${process.env.PORT ?? 3000}`);
}
bootstrap();
