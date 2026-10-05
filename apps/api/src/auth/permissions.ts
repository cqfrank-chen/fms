import type { UserRole } from '../db/schema';

/**
 * ============================================================
 * 登录鉴权 · 角色与权限矩阵（I15）
 * ------------------------------------------------------------
 * 角色（5 种，词表与 db/schema.ts 的 user_role 枚举一一对应）：
 *   admin      管理员 —— 全权（含用户账号、操作人主数据、系统更新、AI 配置）
 *   planner    计划员 —— 订单 / 计划单审核 / 排程 / 产品与主数据维护
 *   warehouse  仓管   —— 入库 / 出库 / 来料登记 / 盘点
 *   accounting 账务   —— 收付款单与核销 / 月度成本 / 对账利润
 *   workshop   车间   —— 报工（计划单行完成数）
 *
 * 落地方式：
 *   · 默认「所有接口都需登录」——全局 AuthGuard（APP_GUARD，见 app.module.ts）；
 *   · 仅 @Public() 放行：GET /api/health、POST /api/auth/login、GET /api（服务名）；
 *   · 读操作（GET）不加 @Roles → 所有已登录角色可用（含 workshop）；
 *   · 写操作加 @Roles(...) 限定，admin 在 RolesGuard 中无条件放行（全权）。
 *
 * 权限矩阵（√ = 允许；admin 列全 √，故下面只列其余角色）：
 * ---------------------------------------------------------------------------------
 *  写操作（接口）                                        planner warehouse accounting workshop
 *  订单 新增/编辑/删除/确认/取消 (orders*)                   √
 *  计划单 审核/驳回 (plan-sheets/:id/audit | reject)         √
 *  计划单 报工 (plan-sheets/:id/report)                      √                            √
 *  排程 排期/取消排期 (scheduling/plan-lines/...)             √
 *  产品/客户/供应商/包装模板 维护 (products|customers|...)     √
 *  工序字典/工作中心 维护 (master-data/*)                     √
 *  产品工序路线 维护 (products/:id/process-routes)            √
 *  入库 手动建单/确认/冲销 (warehouse/receipts*)              √          √
 *  出库 建单/提交/OQC放行/冲销/删草稿 (warehouse/outbounds*)   √          √
 *  来料登记/冲销 (warehouse/incoming*)                       √          √
 *  盘点 建单/确认/冲销 (warehouse/stocktakes*)                √          √
 *  收付款单/核销/冲销 (accounting/collection|payment-slips*)   √                     √
 *  月度成本 (accounting/monthly-costs)                       √                     √
 *  不干胶库存 识别/建档/编辑/调量 (stickers/recognize|POST|PUT|adjust)  √          √
 *  AI 解析/反馈 (ai/orders/*, ai/feedback)                   √
 *  AI 配置写 (ai/config*, ai/test)                          —
 *  操作人主数据 (operators/*)                                —
 *  用户账号 (users/*)                                        —
 *  系统更新 (update/download | apply)                        —
 * ---------------------------------------------------------------------------------
 *  读操作：以上全部 GET 接口 —— 任意已登录角色均可（含 workshop）。
 */

/** 角色中文名（前端 lib/auth.ts 保持同词表，用于顶栏与用户管理展示） */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  planner: '计划员',
  warehouse: '仓管',
  accounting: '账务',
  workshop: '车间',
};
