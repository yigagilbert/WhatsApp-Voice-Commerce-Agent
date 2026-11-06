import { describe, expect, it } from 'vitest';
import { KeyedQueue } from './keyed-queue';

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

describe('KeyedQueue', () => {
  it('runs one key strictly in arrival order, even when the first task is slowest', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const first = gate();
    const a = queue.run('chat', async () => {
      await first.opened;
      order.push('first');
    });
    const b = queue.run('chat', async () => void order.push('second'));
    await Promise.resolve();
    expect(order).toEqual([]);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not make other keys wait', async () => {
    const queue = new KeyedQueue();
    const slow = gate();
    const a = queue.run('slow', () => slow.opened);
    await queue.run('other', async () => undefined);
    slow.open();
    await a;
  });

  it('keeps going after a task fails and forgets idle keys', async () => {
    const queue = new KeyedQueue();
    await expect(queue.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run('k', async () => 'ok')).resolves.toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.size).toBe(0);
  });
});
