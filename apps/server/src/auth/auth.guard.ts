import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Errors } from '../common/errors';
import type { AuthedRequest } from '../common/http';
import { UserStatusService } from './user-status.service';

const QUERY_TOKEN = 'auth:queryToken';

/** 允许通过 ?access_token= 传令牌（仅用于浏览器 EventSource，无法设置请求头） */
export const AllowQueryToken = () => SetMetadata(QUERY_TOKEN, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly statuses: UserStatusService,
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
    const status = await this.statuses.get(userId);
    if (status === 'deleting') throw Errors.deleting();
    if (status !== 'active') throw Errors.suspended();
    req.user = { id: userId };
    return true;
  }
}
