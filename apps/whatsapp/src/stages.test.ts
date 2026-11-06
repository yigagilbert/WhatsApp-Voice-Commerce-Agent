import { describe, expect, it } from 'vitest';
import { StageClock, withTimeout } from './stages';

describe('StageClock', () => {
  it('reports each stage and the total', async () => {
    const clock = new StageClock();
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.mark('api');
    clock.mark('send');
    const stages = clock.stages();
    expect(Object.keys(stages)).toEqual(['api', 'send']);
    expect(stages.api).toBeGreaterThanOrEqual(4);
    expect(clock.total()).toBeGreaterThanOrEqual(stages.api!);
  });
});

describe('withTimeout', () => {
  it('passes results through and gives up on slow work', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
    await expect(withTimeout(new Promise(() => undefined), 5)).rejects.toThrow('timed out');
    await expect(withTimeout(Promise.reject(new Error('no')), 50)).rejects.toThrow('no');
  });
});
