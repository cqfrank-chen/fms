# AGENTS.md

一体化工厂管理系统工作区：订单 → 计划单（产品类型/包装要求/备注）、账目统计、
仓储管理、排期管理，含前端、后端与 AI 接入。绿地项目，走 /wayfinder 决策先行路线。

## Agent skills

### Issue tracker

票据以本地 markdown 文件存放在 `.scratch/<feature-slug>/` 下。见 `docs/agents/issue-tracker.md`。

### Triage labels

默认五角色词汇表：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：根目录一个 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。
