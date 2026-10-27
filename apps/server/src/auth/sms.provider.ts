import { Injectable, Logger } from '@nestjs/common';

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
  /** 发送登录验证码；返回 true 表示可以把验证码回传给调用方（仅开发模式） */
  sendLoginCode(phone: string, code: string): Promise<{ echo: boolean }>;
}

/**
 * 开发模式短信：验证码只写日志并随响应返回，不真正发送。
 * 接入阿里云短信 / 腾讯云短信时实现同一接口，并设置 SMS_MODE=provider。
 */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('SMS');

  async sendLoginCode(phone: string, code: string) {
    this.logger.log(`[开发模式] ${phone.slice(0, 3)}****${phone.slice(-4)} 的登录验证码：${code}`);
    return { echo: true };
  }
}
