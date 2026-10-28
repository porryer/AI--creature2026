import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Errors } from '../common/errors';
import type { AuthedRequest } from '../common/http';
import { Db, DB } from '../db/db';

const QUERY_TOKEN = 'auth:queryToken';

// 账号状态缓存：被冻结的账号最迟 10 秒后所有请求失效（本进程内修改状态时立即失效）
const STATUS_TTL_MS = 10_000;
const statusCache = new Map<string, { status: string; at: number }>();
export const invalidateUserStatus = (userId: string) => statusCache.delete(userId);

/** 允许通过 ?access_token= 传令牌（仅用于浏览器 EventSource，无法设置请求头） */
export const AllowQueryToken = () => SetMetadata(QUERY_TOKEN, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header('authorization');
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token && this.reflector.get<boolean>(QUERY_TOKEN, ctx.getHandler()) && typeof req.query.access_token === 'string') {
      token = req.query.access_token;
    }
    if (!token) throw Errors.unauthenticated();
    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(token);
      if (payload.typ !== 'access' || !payload.sub) throw new Error('wrong token type');
      userId = payload.sub;
    } catch {
      throw Errors.unauthenticated('登录已过期，请重新登录');
    }
    if ((await this.status(userId)) !== 'active') throw Errors.suspended();
    req.user = { id: userId };
    return true;
  }

  private async status(userId: string): Promise<string> {
    const hit = statusCache.get(userId);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
    const [u] = await this.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId]);
    const status = u?.status ?? 'missing';
    statusCache.set(userId, { status, at: Date.now() });
    if (statusCache.size > 10_000) statusCache.delete(statusCache.keys().next().value!);
    return status;
  }
}
