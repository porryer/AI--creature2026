import { Injectable } from '@nestjs/common';
import type { ServerEvent } from '@creature/shared';
import { EventEmitter } from 'node:events';
import { Observable } from 'rxjs';

/**
 * 进程内事件总线：按用户分发任务进度与积分变化。
 * 多实例部署时替换为 Redis Pub/Sub，接口保持不变。
 */
@Injectable()
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(userId: string, event: ServerEvent) {
    this.emitter.emit(userId, event);
  }

  stream(userId: string): Observable<ServerEvent> {
    return new Observable<ServerEvent>((sub) => {
      const fn = (e: ServerEvent) => sub.next(e);
      this.emitter.on(userId, fn);
      return () => this.emitter.off(userId, fn);
    });
  }

  listenerCount(userId: string) {
    return this.emitter.listenerCount(userId);
  }
}
