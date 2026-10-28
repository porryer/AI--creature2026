import { Inject, Injectable } from '@nestjs/common';
import { Db, DB } from '../db/db';
import { EventBus } from '../events/event-bus';

/** 账号状态缓存时长：减少每个请求查库；状态变更时会主动失效 */
const STATUS_TTL_MS = 10_000;
const USER_STATUS_CHANGED = 'user_status';

/**
 * 账号状态（active / frozen / banned）的实例内缓存。
 * 后台修改状态后调用 changed()：本实例立即失效，并通过事件总线通知其他实例失效。
 */
@Injectable()
export class UserStatusService {
  private readonly cache = new Map<string, { status: string; at: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly bus: EventBus,
  ) {
    bus.onControl(USER_STATUS_CHANGED, (d) => typeof d.userId === 'string' && this.cache.delete(d.userId));
  }

  async get(userId: string): Promise<string> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
    const [u] = await this.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId]);
    const status = u?.status ?? 'missing';
    this.cache.set(userId, { status, at: Date.now() });
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
    return status;
  }

  changed(userId: string) {
    this.cache.delete(userId);
    this.bus.control(USER_STATUS_CHANGED, { userId });
  }
}
