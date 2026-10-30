// 业务错误：统一错误码与 HTTP 状态，对应 docs/05-api.md 1.2 节

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const Errors = {
  invalid: (message: string, details?: Record<string, unknown>) => new AppError('INVALID_ARGUMENT', 400, message, details),
  unauthenticated: (message = '请先登录') => new AppError('UNAUTHENTICATED', 401, message),
  forbidden: (message = '无权访问该资源') => new AppError('PERMISSION_DENIED', 403, message),
  planRequired: (message: string, requiredPlan: string) => new AppError('PLAN_FEATURE_REQUIRED', 403, message, { required_plan: requiredPlan }),
  suspended: () => new AppError('ACCOUNT_SUSPENDED', 403, '账号已被限制使用，请联系客服'),
  deleting: () => new AppError('ACCOUNT_DELETING', 403, '账号正在注销，重新登录即可撤销注销'),
  notFound: (what = '资源') => new AppError('NOT_FOUND', 404, `${what}不存在`),
  insufficientCredits: (required: number, available: number) =>
    new AppError('INSUFFICIENT_CREDITS', 402, `积分不足：本次需要 ${required} 积分，当前可用 ${available} 积分`, { required, available }),
  idempotencyConflict: () => new AppError('IDEMPOTENCY_CONFLICT', 409, '相同的 Idempotency-Key 对应了不同的请求内容'),
  conflict: (code: string, message: string) => new AppError(code, 409, message),
  contentRejected: (reason: string) => new AppError('CONTENT_REJECTED', 422, '内容可能违反社区规范，未生成，积分未扣除', { reason_code: reason }),
  rateLimited: (message: string, retryAfterSec: number) => new AppError('RATE_LIMITED', 429, message, { retry_after: retryAfterSec }),
  modelUnavailable: (message = '所选模型及备选模型暂不可用，请稍后再试') => new AppError('MODEL_UNAVAILABLE', 503, message),
};
