import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { defer, Observable } from 'rxjs';
import { runWithOperator } from './operator-context';

/**
 * 免登录留痕：把请求头 X-Operator-Id 放进 AsyncLocalStorage，
 * 服务层写库时用 currentOperatorId() 取值，避免每个接口都加参数。
 */
@Injectable()
export class OperatorInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const raw = req?.headers?.['x-operator-id'];
    const val = Array.isArray(raw) ? raw[0] : raw;
    const id = val && /^\d+$/.test(val) ? Number(val) : null;
    // defer：订阅时才创建下游（在 ALS 上下文内），保证整条异步链路都能读到操作人
    return defer(() => runWithOperator(id, () => next.handle()));
  }
}
