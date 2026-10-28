import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig, CONFIG } from '../config';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { addSeconds } from '../common/time';
import { Db, DB, isUniqueViolation } from '../db/db';
import { CreditsService } from '../credits/credits.service';
import { encryptPhone, hmac, PHONE_RE, randomCode, randomToken, safeEqual, sha256 } from './crypto';
import { SMS_PROVIDER, SmsProvider } from './sms.provider';

const CODE_TTL_SEC = 300;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_INTERVAL_SEC = 60;
const DAILY_LIMIT = 10;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly jwt: JwtService,
    private readonly credits: CreditsService,
  ) {}

  private phoneHash(phone: string) {
    return hmac(this.config.phoneHashKey, phone);
  }

  private codeHash(phoneHash: string, code: string) {
    return hmac(this.config.phoneHashKey, `code:${phoneHash}:${code}`);
  }

  /** 发送登录验证码：同一手机号 60 秒内 1 次、每天最多 10 次 */
  async sendCode(phone: string): Promise<{ expires_in: number; dev_code?: string }> {
    if (!PHONE_RE.test(phone)) throw Errors.invalid('请输入正确的 11 位手机号');
    const ph = this.phoneHash(phone);
    const [stat] = await this.db.query<{ last: Date | null; today: number }>(
      `SELECT MAX(created_at) AS last, COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today FROM sms_codes WHERE phone_hash = $1`,
      [ph],
    );
    if (stat?.last && Date.now() - new Date(stat.last).getTime() < RESEND_INTERVAL_SEC * 1000) {
      const wait = Math.ceil(RESEND_INTERVAL_SEC - (Date.now() - new Date(stat.last).getTime()) / 1000);
      throw Errors.rateLimited(`验证码已发送，请 ${wait} 秒后再试`, wait);
    }
    if ((stat?.today ?? 0) >= DAILY_LIMIT) throw Errors.rateLimited('今天获取验证码的次数已达上限，请明天再试', 3600);

    const code = randomCode();
    await this.db.query('INSERT INTO sms_codes (id, phone_hash, code_hash, expires_at) VALUES ($1, $2, $3, $4)', [
      newId('sms'),
      ph,
      this.codeHash(ph, code),
      addSeconds(new Date(), CODE_TTL_SEC),
    ]);
    const { echo } = await this.sms.sendLoginCode(phone, code);
    return echo && this.config.smsMode === 'dev' ? { expires_in: CODE_TTL_SEC, dev_code: code } : { expires_in: CODE_TTL_SEC };
  }

  /** 验证码登录；首次登录自动注册并发放新手积分 */
  async login(phone: string, code: string, userAgent?: string): Promise<TokenPair & { userId: string; isNew: boolean }> {
    if (!PHONE_RE.test(phone) || !/^\d{6}$/.test(code)) throw Errors.invalid('手机号或验证码格式不正确');
    const ph = this.phoneHash(phone);
    const [row] = await this.db.query<{ id: string; code_hash: string; attempts: number }>(
      `SELECT id, code_hash, attempts FROM sms_codes WHERE phone_hash = $1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [ph],
    );
    if (!row || row.attempts >= CODE_MAX_ATTEMPTS) throw new AppError('CODE_INVALID', 400, '验证码已失效，请重新获取');
    if (!safeEqual(row.code_hash, this.codeHash(ph, code))) {
      await this.db.query('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      throw new AppError('CODE_INVALID', 400, '验证码不正确');
    }
    const consumed = await this.db.query('UPDATE sms_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id', [row.id]);
    if (!consumed.length) throw new AppError('CODE_INVALID', 400, '验证码已使用，请重新获取');

    const { userId, isNew } = await this.findOrCreateUser(phone, ph);
    if (this.config.adminPhones.includes(phone)) await this.db.query(`UPDATE users SET role = 'admin' WHERE id = $1 AND role <> 'admin'`, [userId]);
    // PRD：每日首次登录赠送积分（同一天内幂等）
    await this.credits.ensureDailyGrant(userId);
    const tokens = await this.issue(userId, newId('fam'), userAgent);
    return { ...tokens, userId, isNew };
  }

  private async findOrCreateUser(phone: string, ph: string): Promise<{ userId: string; isNew: boolean }> {
    const existing = await this.db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE phone_hash = $1', [ph]);
    if (existing[0]) {
      if (existing[0].status !== 'active') throw Errors.suspended();
      return { userId: existing[0].id, isNew: false };
    }
    const userId = newId('usr');
    try {
      await this.db.tx(async (q) => {
        await q.query('INSERT INTO users (id, nickname, phone_enc, phone_hash, phone_last4) VALUES ($1, $2, $3, $4, $5)', [
          userId,
          `创作者${phone.slice(-4)}`,
          encryptPhone(phone, this.config.phoneEncKey),
          ph,
          phone.slice(-4),
        ]);
        const accountId = await this.credits.accountIdFor(userId, q);
        await this.credits.grantSignup(q, accountId);
      });
    } catch (e) {
      // 并发注册：另一个请求先创建了同一手机号的账号
      if (isUniqueViolation(e)) return this.findOrCreateUser(phone, ph);
      throw e;
    }
    return { userId, isNew: true };
  }

  /** 刷新令牌轮换；检测到旧令牌被重复使用时吊销整个令牌族 */
  async refresh(refreshToken: string, userAgent?: string): Promise<TokenPair & { userId: string }> {
    const [s] = await this.db.query<SessionRow & { status: string }>(
      `SELECT s.*, u.status FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
      [sha256(refreshToken)],
    );
    if (!s) throw Errors.unauthenticated('登录状态已失效，请重新登录');
    if (s.revoked_at) {
      if (s.replaced_by) await this.db.query('UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [s.family_id]);
      throw Errors.unauthenticated('登录状态已失效，请重新登录');
    }
    if (new Date(s.expires_at).getTime() < Date.now()) throw Errors.unauthenticated('登录已过期，请重新登录');
    if (s.status !== 'active') throw Errors.suspended();
    const tokens = await this.issue(s.user_id, s.family_id, userAgent, s.id);
    return { ...tokens, userId: s.user_id };
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    await this.db.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(refreshToken)]);
  }

  private async issue(userId: string, familyId: string, userAgent?: string, replaces?: string): Promise<TokenPair> {
    const refreshToken = randomToken();
    const id = newId('ses');
    await this.db.tx(async (q) => {
      if (replaces) {
        const r = await q.query('UPDATE auth_sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id', [replaces, id]);
        // 并发刷新：同一令牌只能成功轮换一次
        if (!r.length) throw Errors.unauthenticated('登录状态已失效，请重新登录');
      }
      await q.query('INSERT INTO auth_sessions (id, user_id, family_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6)', [
        id,
        userId,
        familyId,
        sha256(refreshToken),
        addSeconds(new Date(), this.config.refreshTtlSec),
        userAgent?.slice(0, 200) ?? null,
      ]);
      // 每个用户最多保留 N 个活跃会话，超出时吊销最早的
      await q.query(
        `UPDATE auth_sessions SET revoked_at = now() WHERE id IN (
           SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC OFFSET $2)`,
        [userId, this.config.maxSessionsPerUser],
      );
    });
    const accessToken = await this.jwt.signAsync({ sub: userId, typ: 'access' }, { expiresIn: this.config.accessTtlSec });
    return { accessToken, refreshToken, expiresIn: this.config.accessTtlSec };
  }
}
