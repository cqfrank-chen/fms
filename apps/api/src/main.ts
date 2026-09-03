import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { runMigrations } from './db/migrate';

async function bootstrap() {
  // 启动时自动建表/迁移（postgres 就绪后幂等执行）
  await runMigrations();

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api'); // 统一 /api 前缀（nginx 反代 /api → app）
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
  console.log(`API listening on http://localhost:${process.env.PORT ?? 3000}`);
}
bootstrap();
