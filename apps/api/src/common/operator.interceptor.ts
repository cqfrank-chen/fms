import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { defer, Observable } from 'rxjs';
import { runWithOperator } from './operator-context';

/**
 * 留痕：把「本次请求的经办人」放进 AsyncLocalStorage，服务层写库时用 currentOperatorId() 取值，
 * 避免每个接口都加参数。取值优先级：
 *   1) 登录用户绑定的 operator_id（AuthGuard 已把用户写入 req.user）—— 正式鉴权后的主路径；
 *   2) 请求头 X-Operator-Id（免登录期的本机绑定）—— 向后兼容保留。
 */
@Injectable()
export class OperatorInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx
      .switchToHttp()
      .getRequest<{
        headers?: Record<string, string | string[] | undefined>;
        user?: { operatorId?: number | null };
      }>();
    const raw = req?.headers?.['x-operator-id'];
    const val = Array.isArray(raw) ? raw[0] : raw;
    const fromHeader = val && /^\d+$/.test(val) ? Number(val) : null;
    const bound = req?.user?.operatorId;
    const id = typeof bound === 'number' && Number.isFinite(bound) ? bound : fromHeader;
    // defer：订阅时才创建下游（在 ALS 上下文内），保证整条异步链路都能读到操作人
    return defer(() => runWithOperator(id, () => next.handle()));
  }
}
