import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AccountingService } from '../accounting/accounting.service';
import { LlmGatewayService } from './llm-gateway.service';
import { QaService } from './qa.service';
import { ReportSummaryService } from './report-summary.service';
import { RuleAlertService } from './rule-alerts.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly llm: LlmGatewayService,
    private readonly ruleAlerts: RuleAlertService,
    private readonly accounting: AccountingService,
    private readonly summarySvc: ReportSummaryService,
    private readonly qa: QaService,
  ) {}

  /** AI 网关探活：返回当前模式（live=真 DeepSeek / mock=未配 key 降级）与模型 */
  @Get('health')
  health() {
    return {
      ok: true,
      mode: this.llm.live ? 'live' : 'mock',
      chatModel: this.llm.live ? undefined : '未配置（AI_API_KEY 为空 → mock 降级）',
      hint: this.llm.live
        ? '文本链路真实调用 DeepSeek；图片解析仍需 AI_VISION_KEY'
        : '填 .env 的 AI_API_KEY 后重启即切真实模型',
    };
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
