import { Body, Controller, Global, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { Response } from 'express';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import { Errors } from '../common/errors';
import { AuthedRequest, parse } from '../common/http';
import { CreditsModule } from '../credits/credits.module';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { ConsoleSmsProvider, SMS_PROVIDER } from './sms.provider';

export const REFRESH_COOKIE = 'crt_rt';

const SendSchema = z.object({ phone: z.string().trim() });
const LoginSchema = z.object({ phone: z.string().trim(), code: z.string().trim() });
const RefreshSchema = z.object({ refresh_token: z.string().optional() }).optional();

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('sms/send')
  @HttpCode(200)
  send(@Body() body: unknown) {
    return this.auth.sendCode(parse(SendSchema, body).phone);
  }

  @Post('sms/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const { phone, code } = parse(LoginSchema, body);
    const r = await this.auth.login(phone, code, req.header('user-agent'));
    this.setCookie(res, r.refreshToken);
    return { access_token: r.accessToken, expires_in: r.expiresIn, user_id: r.userId, is_new: r.isNew };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? parse(RefreshSchema, body)?.refresh_token;
    if (!token) throw Errors.unauthenticated('请先登录');
    try {
      const r = await this.auth.refresh(token, req.header('user-agent'));
      this.setCookie(res, r.refreshToken);
      return { access_token: r.accessToken, expires_in: r.expiresIn, user_id: r.userId };
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOpts());
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, this.cookieOpts());
  }

  private cookieOpts() {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.config.cookieSecure, path: '/v1/auth' };
  }

  private setCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, { ...this.cookieOpts(), maxAge: this.config.refreshTtlSec * 1000 });
  }
}

/** 认证模块全局导出 AuthGuard 与 JwtService，业务模块无需重复导入 */
@Global()
@Module({
  imports: [
    CreditsModule,
    JwtModule.registerAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    {
      provide: SMS_PROVIDER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => {
        // 真实短信服务商适配器尚未接入：宁可启动失败，也不要让用户收不到验证码
        if (config.smsMode !== 'dev') throw new Error('SMS_MODE=provider 需要先实现短信服务商适配器（见 src/auth/sms.provider.ts）');
        return new ConsoleSmsProvider();
      },
    },
  ],
  exports: [AuthGuard, JwtModule],
})
export class AuthModule {}
