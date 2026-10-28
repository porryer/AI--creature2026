import type { ServerEvent, TaskDTO } from '@creature/shared';
import type { AppConfig } from '../src/config';
import type { Db } from '../src/db/db';
import { EventBus } from '../src/events/event-bus';

/** 用内存实现的 listen / notify 模拟多实例：notify 的消息投递给所有订阅者（含自己） */
function cluster() {
  const subscribers: ((payload: string) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const db = {
    listen: async (_channel: string, onMessage: (payload: string) => void) => {
      subscribers.push(onMessage);
      return async () => undefined;
    },
    notify: async (_channel: string, payload: string) => {
      sent.push(JSON.parse(payload));
      subscribers.forEach((s) => s(payload));
    },
  } as unknown as Db;
  const make = async () => {
    const bus = new EventBus(db, { eventsChannel: 'test_events' } as AppConfig);
    await bus.onApplicationBootstrap();
    return bus;
  };
  return { sent, make };
}

const task = (id: string, status: TaskDTO['status'], prompt = '海报') => ({ id, status, prompt }) as TaskDTO;
const flush = () => new Promise((r) => setImmediate(r));

describe('事件总线（跨实例广播规则）', () => {
  it('同一状态内的进度更新限频；状态变化与完成事件总是广播', async () => {
    const { sent, make } = cluster();
    const a = await make();
    a.broadcastTask('u1', 'task.progress', { id: 't1', status: 'queued' });
    a.broadcastTask('u1', 'task.progress', { id: 't1', status: 'running' }); // 状态变化
    a.broadcastTask('u1', 'task.progress', { id: 't1', status: 'running' }); // 1.5 秒内同一状态：跳过
    a.broadcastTask('u1', 'task.progress', { id: 't1', status: 'post_processing' });
    a.broadcastTask('u1', 'task.succeeded', { id: 't1', status: 'succeeded' });
    expect(sent.map((m) => [m.t, m.id])).toEqual([
      ['task.progress', 't1'],
      ['task.progress', 't1'],
      ['task.progress', 't1'],
      ['task.succeeded', 't1'],
    ]);
  });

  it('任务内容放得下时随通知发送，超过上限时只发引用', async () => {
    const { sent, make } = cluster();
    const a = await make();
    a.emit('u1', { type: 'task.succeeded', task: task('t1', 'succeeded') });
    a.emit('u1', { type: 'task.succeeded', task: task('t2', 'succeeded', '长'.repeat(4000)) });
    expect(sent[0]).toMatchObject({ id: 't1', task: { prompt: '海报' } });
    expect(sent[1]).toMatchObject({ id: 't2' });
    expect(sent[1].task).toBeUndefined();
  });

  it('接收方：忽略自己发出的通知；本实例没有该用户的连接时不读取任务；控制消息总是处理', async () => {
    const { make } = cluster();
    const a = await make();
    const b = await make();
    const loader = jest.fn(async (_u: string, id: string) => task(id, 'succeeded'));
    a.setTaskLoader(loader);
    b.setTaskLoader(loader);
    const control = jest.fn();
    b.onControl('ping', control);

    const onA: ServerEvent[] = [];
    const onB: ServerEvent[] = [];
    const subA = a.stream('u1').subscribe((e) => onA.push(e));
    const subB = b.stream('u1').subscribe((e) => onB.push(e));
    a.emit('u1', { type: 'task.succeeded', task: task('t1', 'succeeded') });
    a.broadcastTask('u2', 'task.succeeded', { id: 't2', status: 'succeeded' }); // 没有 u2 的连接
    a.broadcastTask('u1', 'task.failed', { id: 't3', status: 'failed' }); // 只有引用：B 读取
    a.control('ping', { n: 1 });
    await flush();

    expect(onA.map((e) => e.type)).toEqual(['task.succeeded']); // 只有本地那一次
    expect(onB.map((e) => (e.type === 'sync' || e.type === 'credits.changed' ? e.type : `${e.type}:${e.task.id}`))).toEqual(['task.succeeded:t1', 'task.failed:t3']);
    expect(loader.mock.calls).toEqual([['u1', 't3']]);
    expect(control).toHaveBeenCalledWith({ n: 1 });
    subA.unsubscribe();
    subB.unsubscribe();
  });
});
