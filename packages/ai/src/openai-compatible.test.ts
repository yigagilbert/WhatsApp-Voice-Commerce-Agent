import { describe, expect, it } from 'vitest';
import { OpenAICompatibleChatModel } from './openai-compatible';

const answer = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });

const modelWith = (...steps: (() => Response | Promise<Response>)[]) => {
  let calls = 0;
  const model = new OpenAICompatibleChatModel({
    baseUrl: 'https://llm.test/v1',
    apiKey: 'k',
    model: 'm',
    timeoutMs: 20,
    fetch: (async (_url: string, init: RequestInit) => {
      const step = steps[calls++];
      if (!step) throw new Error('too many calls');
      void init;
      return step();
    }) as unknown as typeof fetch,
  });
  return { model, calls: () => calls };
};
const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };
const hang = () => Promise.reject(new DOMException('timed out', 'TimeoutError'));

describe('OpenAICompatibleChatModel retries', () => {
  it('retries once after a hang', async () => {
    const { model, calls } = modelWith(hang, answer);
    await expect(model.complete(ask)).resolves.toMatchObject({ message: { content: 'ok' } });
    expect(calls()).toBe(2);
  });

  it.each([429, 500, 503])('retries once after HTTP %i', async (status) => {
    const { model, calls } = modelWith(() => new Response('busy', { status }), answer);
    await model.complete(ask);
    expect(calls()).toBe(2);
  });

  it('gives up after the second failure with a provider error', async () => {
    const { model, calls } = modelWith(hang, hang);
    await expect(model.complete(ask)).rejects.toMatchObject({
      code: expect.stringMatching(/^PROVIDER/),
    });
    expect(calls()).toBe(2);
  });

  it('does not retry a request the provider refused', async () => {
    const { model, calls } = modelWith(() => new Response('bad', { status: 400 }), answer);
    await expect(model.complete(ask)).rejects.toThrow();
    expect(calls()).toBe(1);
  });
});
