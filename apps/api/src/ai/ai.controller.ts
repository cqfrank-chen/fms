import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AccountingService } from '../accounting/accounting.service';
import { Roles } from '../auth/decorators';
import { AI_CONFIG_FIELDS, AiConfigService } from './ai-config.service';
import type { AiConfig } from './ai-config.service';
import { LlmGatewayService } from './llm-gateway.service';
import { QaService } from './qa.service';
import { ReportSummaryService } from './report-summary.service';
import { RuleAlertService } from './rule-alerts.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly llm: LlmGatewayService,
    private readonly aiCfg: AiConfigService,
    private readonly ruleAlerts: RuleAlertService,
    private readonly accounting: AccountingService,
    private readonly summarySvc: ReportSummaryService,
    private readonly qa: QaService,
  ) {}

  /** AI 网关探活：返回当前模式（live=已配 key / mock=未配降级）与模型 */
  @Get('health')
  async health() {
    const cfg = await this.llm.getConfig();
    const chat = !!cfg.chatApiKey;
    const vision = !!cfg.visionApiKey;
    return {
      ok: true,
      mode: chat ? 'live' : 'mock',
      chatModel: chat ? cfg.chatModel : '未配置（对话 API Key 为空 → mock 降级）',
      hint: chat
        ? vision
          ? '文本与识图均已配置，真实模型调用'
          : '文本链路真实调用；识图 Key 未配置（到设置页填写）'
        : '到「设置 · 主数据 → AI 服务」填写对话/识图 Key，保存即生效（无需重启）',
    };
  }

  /** AI 配置回显（脱敏）：key 只给 keySet/keyHint，不回明文；非 key 字段给当前值与 .env 默认 */
  @Get('config')
  async config() {
    const cfg = await this.llm.getConfig();
    const out: Record<string, { keySet?: boolean; keyHint?: string; value?: string; default?: string }> = {};
    for (const { field, envKey } of AI_CONFIG_FIELDS) {
      const v = cfg[field];
      if (field.endsWith('ApiKey')) {
        out[field] = { keySet: !!v, keyHint: v ? `…${v.slice(-4)}` : '' };
      } else {
        out[field] = { value: v, default: process.env[envKey] ?? '' };
      }
    }
    return out;
  }

  /** 保存 AI 配置：patch 中 undefined=不改、空串=清除（回退 .env）；保存即生效 */
  @Roles('admin')
  @Post('config')
  async saveConfig(@Body() body: Record<string, unknown>) {
    const patch: Partial<Record<keyof AiConfig, string | undefined>> = {};
    for (const { field } of AI_CONFIG_FIELDS) {
      const v = body[field];
      if (v === undefined) continue;
      if (typeof v !== 'string') throw new BadRequestException(`字段 ${field} 须为字符串`);
      patch[field] = v;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('没有可保存的字段');
    await this.aiCfg.save(patch);
    await this.llm.refreshConfig();
    const after = await this.llm.getConfig();
    return {
      ok: true,
      chatKeySet: !!after.chatApiKey,
      visionKeySet: !!after.visionApiKey,
      hint: '已保存并立即生效（对话/识图新 Key 无需重启）',
    };
  }

  /** 清除全部 DB 覆盖（回退 .env 默认） */
  @Roles('admin')
  @Post('config/reset')
  async resetConfig() {
    await this.aiCfg.reset();
    await this.llm.refreshConfig();
    return { ok: true, hint: '已回退到 .env 默认配置' };
  }

  /** 连通性测试：真实发一条最小请求验证 key/baseUrl/model */
  @Roles('admin')
  @Post('test')
  async test(@Body('kind') kind?: string) {
    if (kind === 'chat') return this.llm.testChat();
    if (kind === 'vision') return this.llm.testVision();
    throw new BadRequestException('kind 须为 chat 或 vision');
  }

  /** 规则预警（确定性引擎）：安全库存/应收账龄逾期/交期冲突 */
  @Get('alerts')
  listAlerts() {
    return this.ruleAlerts.list();
  }

  /** 利润月报摘要：profit 数据 → 模板渲染 + LLM 摘要 + 数字回核（无幻觉） */
  @Get('report-summary')
  async getReportSummary(@Query('month') month?: string) {
    const m = month ?? currentMonth();
    if (!/^\d{4}-\d{2}$/.test(m)) throw new BadRequestException('月份格式须为 YYYY-MM');
    const profit = await this.accounting.profit(m);
    return this.summarySvc.summarize(profit);
  }
  /** 自然语言查数：function calling（LLM 选工具 → 后端确定执行 → 汇总） */
  @Post('ask')
  async ask(@Body('question') question?: string) {
    if (!question?.trim()) throw new BadRequestException('问题不能为空');
    return this.qa.ask(question.trim());
  }
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
