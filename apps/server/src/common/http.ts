import { ArgumentsHost, Catch, createParamDecorator, ExceptionFilter, ExecutionContext, HttpException, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { AppError, Errors } from './errors';
import { newId } from './ids';

export interface AuthedRequest extends Request {
  requestId?: string;
  user?: { id: string };
}

/** 为每个请求分配 X-Request-Id，便于日志与链路追踪关联 */
export function requestIdMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : newId('req');
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

const STATUS_CODE: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** 统一错误响应：{ error: { code, message, details, request_id } } */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AuthedRequest>();
    const res = ctx.getResponse<Response>();
    let status = 500;
    let body: { code: string; message: string; details?: Record<string, unknown> };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details };
      if (exception.code === 'RATE_LIMITED' && exception.details?.retry_after) res.setHeader('Retry-After', String(exception.details.retry_after));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { code: STATUS_CODE[status] ?? `HTTP_${status}`, message: status === 404 ? '接口不存在' : exception.message };
    } else {
      this.logger.error(`[${req.requestId}] ${req.method} ${req.originalUrl}`, exception instanceof Error ? exception.stack : String(exception));
      body = { code: 'INTERNAL', message: '服务器开小差了，请稍后重试' };
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { ...body, request_id: req.requestId } });
  }
}

/** 用 zod 校验请求数据，失败时返回 400 与字段明细 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw Errors.invalid('参数校验失败', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** 当前登录用户 ID */
export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw Errors.unauthenticated();
  return req.user.id;
});

/** 游标分页：游标为上一页最后一条记录的 ID（ID 按时间有序） */
export function pageParams(query: Record<string, unknown>, max = 50): { cursor: string | null; limit: number } {
  const limit = Math.min(max, Math.max(1, Number(query.limit ?? 20) || 20));
  const cursor = typeof query.cursor === 'string' && /^[a-z]+_[0-9a-z]+$/.test(query.cursor) ? query.cursor : null;
  return { cursor, limit };
}
