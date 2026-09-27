import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 当前请求的操作人（免登录留痕，spec §9）。
 * 由 OperatorInterceptor 从请求头 X-Operator-Id 注入（前端「当前操作人 = PC 绑定」写入 localStorage 后随每个请求携带）。
 */
const als = new AsyncLocalStorage<number | null>();

export const runWithOperator = <T>(operatorId: number | null, fn: () => T): T => als.run(operatorId, fn);

/** 读取当前操作人 id；未绑定/离线调用返回 null（不阻断业务写入） */
export const currentOperatorId = (): number | null => {
  const v = als.getStore();
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
