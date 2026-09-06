import { Injectable, Logger } from '@nestjs/common';
import { AiConfigService } from './ai-config.service';
import type { AiConfig } from './ai-config.service';

/**
 * LLM 网关（I12）：OpenAI 兼容统一入口，供应商可切换。
 *
 * - 文本/查数/摘要：DeepSeek（AI_API_KEY / AI_BASE_URL / AI_CHAT_MODEL）
 * - 视觉（订单图片）：AI_VISION_KEY 未配置时不可用（由上层降级），协议与 OpenAI 视觉一致
 * - 无 key → mock 降级：返回 `[mock]` 前缀占位，保证 UI 全链路不断、可离线开发
 *
 * 设计约束（调研 02-ai-integration §1.2）：统一 OpenAI 兼容接口 + 网关层，
 * key 缺失不阻塞工程，填入 .env 重启即切真实模型。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface LlmToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  json?: boolean; // response_format: json_object（强制结构化输出，源头消灭格式幻觉）
  tools?: LlmToolDef[];
  temperature?: number;
  /** 指定模型（默认 AI_CHAT_MODEL） */
  model?: string;
  /** 显式模式；默认 auto（有 key 真调、无 key mock） */
  mode?: 'auto' | 'live' | 'mock';
  /** 视觉图片（dataURL），传了走视觉通道 */
  images?: string[];
  visionPrompt?: string;
}

export interface ChatResult {
  provider: 'deepseek' | 'mock';
  text: string;
  /** function calling：LLM 选择要调用的工具（I12 查数用） */
  toolCalls?: Array<{ name: string; arguments: string }>;
  /** mock 标记：真实模型调用失败/未配置时的降级响应 */
  mock?: boolean;
}

@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);
  /** 生效配置缓存（AiConfigService.load = env 默认 + DB 覆盖）；保存配置后调 refreshConfig() 失效重载 */
  private cache: AiConfig | null = null;

  constructor(private readonly aiCfg: AiConfigService) {}

  /** 当前生效配置（缓存） */
  async getConfig(): Promise<AiConfig> {
    if (!this.cache) this.cache = await this.aiCfg.load();
    return this.cache;
  }

  /** 配置被修改后调用：清缓存，下次请求重新 load（立即生效） */
  async refreshConfig(): Promise<AiConfig> {
    this.cache = await this.aiCfg.load();
    return this.cache;
  }

  /** 对话通道是否已配 key（live）；DB/设置页配置也计入 */
  async hasChatKey(): Promise<boolean> {
    return !!(await this.getConfig()).chatApiKey;
  }

  /** 视觉通道是否已配 key */
  async hasVisionKey(): Promise<boolean> {
    return !!(await this.getConfig()).visionApiKey;
  }

  /** OpenAI 兼容 /chat/completions */
  async chat(messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const mode = opts.mode ?? 'auto';
    if (mode === 'mock' || (mode === 'auto' && !(await this.hasChatKey()))) {
      return this.mockResult(messages, opts);
    }
    return this.liveChat(messages, opts);
  }

  /** 视觉通道（订单图片解析）；视觉 key 缺失抛错由上层降级 */
  async vision(images: string[], prompt: string, opts: ChatOptions = {}): Promise<ChatResult> {
    const cfg = await this.getConfig();
    const vKey = cfg.visionApiKey;
    if (!vKey) throw new Error('识图 API Key 未配置：请到「设置 · 主数据 → AI 服务」填写（如阿里云百炼 qwen3-vl-flash）');
    const vBase = (cfg.visionBaseUrl || cfg.chatBaseUrl).replace(/\/$/, '');
    const vModel = cfg.visionModel;
    const content = [
      { type: 'text', text: prompt },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    return this.postCompletion(vBase, vKey, vModel, [{ role: 'user', content } as never], opts);
  }

  private async liveChat(messages: LlmMessage[], opts: ChatOptions): Promise<ChatResult> {
    const cfg = await this.getConfig();
    const model = opts.model ?? cfg.chatModel;
    return this.postCompletion(cfg.chatBaseUrl, cfg.chatApiKey, model, messages, opts);
  }

  /** 连通性测试（设置页「测试连接」用）：真实发一条最小消息，返回可读结果 */
  async testChat(): Promise<{ ok: boolean; message: string }> {
    const cfg = await this.getConfig();
    if (!cfg.chatApiKey) return { ok: false, message: '对话 API Key 未配置' };
    try {
      await this.postCompletion(cfg.chatBaseUrl, cfg.chatApiKey, cfg.chatModel, [
        { role: 'user', content: '回复 OK 两个字母即可' },
      ], { temperature: 0 }, true);
      return { ok: true, message: `连接成功（${cfg.chatModel} @ ${cfg.chatBaseUrl}）` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** 视觉连通性测试 */
  async testVision(): Promise<{ ok: boolean; message: string }> {
    const cfg = await this.getConfig();
    if (!cfg.visionApiKey) return { ok: false, message: '识图 API Key 未配置' };
    const vBase = (cfg.visionBaseUrl || cfg.chatBaseUrl).replace(/\/$/, '');
    // 1x1 红点 png（dataURL），仅验证鉴权与通道可达
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    try {
      await this.postCompletion(vBase, cfg.visionApiKey, cfg.visionModel, [{
        role: 'user',
        content: [{ type: 'text', text: '回复 OK' }, { type: 'image_url', image_url: { url: px } }],
      } as never], { temperature: 0 }, true);
      return { ok: true, message: `识图连接成功（${cfg.visionModel} @ ${vBase}）` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  private async postCompletion(base: string, key: string, model: string, messages: unknown[], opts: ChatOptions, strict = false): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.1,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.tools?.length) body.tools = opts.tools;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
      };
      const msg = data.choices?.[0]?.message;
      const text = msg?.content ?? '';
      const toolCalls = (msg?.tool_calls ?? [])
        .filter((tc) => tc.function?.name)
        .map((tc) => ({ name: tc.function!.name!, arguments: tc.function!.arguments ?? '{}' }));
      this.logger.log(`LLM ok: model=${model} toolCalls=${toolCalls.length} textLen=${text.length}`);
      return { provider: 'deepseek', text, toolCalls };
    } catch (e) {
      if (strict) throw e; // 测试模式：错误透传（不降级 mock）
      // 网络/限流失败：不静默——记录并降级 mock，保证业务链路不被单点拖死
      this.logger.warn(`LLM call failed, fallback mock: ${(e as Error).message}`);
      return this.mockResult(messages as LlmMessage[], opts);
    } finally {
      clearTimeout(timer);
    }
  }

  private mockResult(messages: LlmMessage[], opts: ChatOptions): ChatResult {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const hint = last.match(/\[MOCK_CASE[:=]?\s*([A-Za-z0-9_-]+)\]/)?.[1];
    if (hint && opts.json) {
      const sample = MOCK_JSON_CASES[hint];
      if (sample) return { provider: 'mock', text: JSON.stringify(sample), mock: true };
    }
    const echo = `[mock:未配置对话API Key，到设置页填写] ${last.slice(0, 120)}`;
    return { provider: 'mock', text: opts.json ? JSON.stringify({ mock: true, echo }) : echo, mock: true };
  }
}

/**
 * mock 可编程样本（仅网关测试/离线开发用）：key 缺失时上层可在 prompt 里注入
 * `[MOCK_CASE=xxx]` 取到与真实模型同构的 JSON，用于跑通链路与验收脚本。
 * 验收真实直通率须配置真 key 后运行（本表不做业务承诺）。
 */
export const MOCK_JSON_CASES: Record<string, unknown> = {
  order_normal: {
    customerName: '测试客户', poNo: 'PO-88231', dueDate: '2026-09-30',
    lines: [{ productName: 'PNM-3', quantity: 2000, unitPrice: 4.2, currency: 'USD', engraving: '', packaging: { box: '100只/盒' } }],
    confidence: 'high', notes: [],
  },
  order_unknown_customer: {
    customerName: '从未见过的公司 XYZ', poNo: 'XYZ-1', dueDate: '2026-10-15',
    lines: [{ productName: 'ANM-3', quantity: 1000, unitPrice: 3.5, currency: 'USD' }],
    confidence: 'low', notes: ['客户不在主数据，需确认是否为新增客户'],
  },
};
