import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { appSettings } from '../db/schema';

/**
 * AI 服务配置（设置页可改，DB 优先于 .env）：
 *
 * - 持久层 app_settings 表（key 前缀 ai.*），运行时可写，无需重启
 * - 读取顺序：DB 有值 → DB 值；DB 无值 → .env（compose 注入的 AI_*）
 * - key 明文存库（厂内单机、免登录局域网场景，与系统其余数据同级信任）
 */

export interface AiConfig {
  chatApiKey: string;
  chatBaseUrl: string;
  chatModel: string;
  visionApiKey: string;
  visionBaseUrl: string;
  visionModel: string;
}

const KEYS = {
  chatApiKey: 'ai.chatApiKey',
  chatBaseUrl: 'ai.chatBaseUrl',
  chatModel: 'ai.chatModel',
  visionApiKey: 'ai.visionApiKey',
  visionBaseUrl: 'ai.visionBaseUrl',
  visionModel: 'ai.visionModel',
} as const;

/** 可供设置页编辑的字段（脱敏回显用） */
export const AI_CONFIG_FIELDS: Array<{ field: keyof AiConfig; label: string; envKey: string }> = [
  { field: 'chatApiKey', label: '对话 API Key', envKey: 'AI_API_KEY' },
  { field: 'chatBaseUrl', label: '对话接口地址', envKey: 'AI_BASE_URL' },
  { field: 'chatModel', label: '对话模型', envKey: 'AI_CHAT_MODEL' },
  { field: 'visionApiKey', label: '识图 API Key', envKey: 'AI_VISION_KEY' },
  { field: 'visionBaseUrl', label: '识图接口地址', envKey: 'AI_VISION_BASE_URL' },
  { field: 'visionModel', label: '识图模型', envKey: 'AI_VISION_MODEL' },
];

@Injectable()
export class AiConfigService {
  constructor(private readonly cfg: ConfigService) {}

  /** 读取当前生效配置：DB 覆盖 env 默认 */
  async load(): Promise<AiConfig> {
    const rows = await db.select().from(appSettings);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const get = (dbKey: string, envKey: string, fallback: string): string =>
      map.get(dbKey) ?? this.cfg.get<string>(envKey) ?? fallback;
    return {
      chatApiKey: map.get(KEYS.chatApiKey) ?? this.cfg.get<string>('AI_API_KEY') ?? '',
      chatBaseUrl: (get(KEYS.chatBaseUrl, 'AI_BASE_URL', 'https://api.deepseek.com/v1')).replace(/\/$/, ''),
      chatModel: get(KEYS.chatModel, 'AI_CHAT_MODEL', 'deepseek-chat'),
      visionApiKey: map.get(KEYS.visionApiKey) ?? this.cfg.get<string>('AI_VISION_KEY') ?? '',
      visionBaseUrl: (get(KEYS.visionBaseUrl, 'AI_VISION_BASE_URL', '')).replace(/\/$/, ''),
      visionModel: get(KEYS.visionModel, 'AI_VISION_MODEL', 'qwen3-vl-flash'),
    };
  }

  /**
   * 保存配置：patch 中 undefined=不改；空串=清除（回退 .env 默认）
   * 返回保存后的完整配置（供网关刷新缓存）
   */
  async save(patch: Partial<Record<keyof AiConfig, string | undefined>>): Promise<AiConfig> {
    for (const [field, dbKey] of Object.entries(KEYS) as Array<[keyof AiConfig, string]>) {
      const v = patch[field];
      if (v === undefined) continue; // 未传：不动
      if (v === '') {
        // 清除 DB 覆盖 → 回退 env
        await db.delete(appSettings).where(eq(appSettings.key, dbKey));
      } else {
        await db
          .insert(appSettings)
          .values({ key: dbKey, value: v })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: v, updatedAt: new Date() } });
      }
    }
    return this.load();
  }

  /** 清除全部 DB 覆盖（回退 .env） */
  async reset(): Promise<AiConfig> {
    await db.delete(appSettings);
    return this.load();
  }
}
