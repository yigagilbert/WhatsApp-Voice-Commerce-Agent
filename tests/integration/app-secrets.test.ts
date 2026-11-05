/**
 * API keys set from the dashboard, against a real Postgres: encrypted at rest, never returned, limited
 * to the installation's owners, in force immediately, and falling back to the environment.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { FakePayPal, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const otherShop = `sec_other_${run}`;
const SECRET = `sk-test-${run}-do-not-leak-ABCD`;
const LICENCE = `licence-${run}-WXYZ`;
const auth = { authorization: 'Bearer test-dashboard-token-123456' };

describe('API keys from the dashboard (integration)', () => {
  let container: Container;
  let app: FastifyInstance;
  let firstMerchant: string;
  const realFetch = globalThis.fetch;
  /** Whatever a developer's database already holds is put back afterwards. */
  let savedRows: Awaited<ReturnType<Container['db']['appSecret']['findMany']>> = [];

  /** Stands in for the AI provider, capturing what the API sends it. */
  const provider = (status = 200) => {
    const mock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes('/models')) return new Response('{}', { status });
      return new Response(
        JSON.stringify({ id: 'c1', model: 'gpt', choices: [{ message: { content: 'hi' } }] }),
        { status },
      );
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  const headers = (merchantId?: string) => ({
    ...auth,
    ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
  });
  const put = (name: string, value: string, merchantId?: string) =>
    app.inject({
      method: 'PUT',
      url: `/api/settings/keys/${name}`,
      headers: headers(merchantId),
      payload: { value },
    });
  const statusOf = async (name: string) => {
    const res = await app.inject({ url: '/api/settings/keys', headers: headers(firstMerchant) });
    return (res.json() as { name: string; source: string; hint: string | null }[]).find(
      (k) => k.name === name,
    );
  };

  beforeAll(async () => {
    const config = parseConfig(
      apiSchema,
      testEnv({ AI_API_KEY: 'env-key-1234', AI_BASE_URL: 'https://ai.example.test/v1' }),
    );
    container = createContainer(config, createLogger({ name: 'it-sec', level: 'silent' }), {
      paypal: new FakePayPal(`SEC-${run}`),
    });
    app = await buildApp(container);
    savedRows = await container.db.appSecret.findMany();
    await container.db.appSecret.deleteMany();
    let first = await container.db.merchant.findFirst({ orderBy: { createdAt: 'asc' } });
    first ??= await container.db.merchant.create({
      data: { id: `sec_first_${run}`, businessName: 'First', ownerName: 'Owner' },
    });
    firstMerchant = first.id;
    await container.db.merchant.create({
      data: { id: otherShop, businessName: 'Other', ownerName: 'Other Owner' },
    });
  });

  afterEach(async () => {
    vi.stubGlobal('fetch', realFetch);
    await container.secrets.refresh();
  });

  afterAll(async () => {
    await container.db.appSecret.deleteMany();
    if (savedRows.length) await container.db.appSecret.createMany({ data: savedRows });
    await container.db.merchant.deleteMany({ where: { id: otherShop } });
    await app?.close();
  });

  it('uses the environment until a key is saved', async () => {
    expect(await statusOf('AI_API_KEY')).toMatchObject({ source: 'environment', hint: '1234' });
    expect(container.secrets.get('AI_API_KEY')).toBe('env-key-1234');
  });

  it('stores keys encrypted, returns only a hint, and audits without the value', async () => {
    provider();
    const res = await put('AI_API_KEY', SECRET, firstMerchant);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);

    const row = await container.db.appSecret.findUniqueOrThrow({ where: { name: 'AI_API_KEY' } });
    expect(row.ciphertext).not.toContain(SECRET);
    expect(row.ciphertext).not.toContain('do-not-leak');

    const list = await app.inject({ url: '/api/settings/keys', headers: headers(firstMerchant) });
    expect(list.body).not.toContain(SECRET);
    expect(await statusOf('AI_API_KEY')).toMatchObject({ source: 'dashboard', hint: 'ABCD' });

    const audit = await container.audit.list(firstMerchant, 20);
    expect(JSON.stringify(audit)).toContain('settings.key_saved');
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('applies a new key immediately to the assistant and the agents, with no restart', async () => {
    const mock = provider();
    await put('AI_API_KEY', SECRET, firstMerchant);
    expect(container.chatModel?.available).toBe(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/assistant-turn',
      headers: headers(firstMerchant),
      payload: { model: 'attacker-choice', messages: [] },
    });
    expect(res.json()).toMatchObject({ ok: true, completion: { id: 'c1' } });
    const [url, init] = mock.mock.calls.at(-1)!;
    expect(String(url)).toBe('https://ai.example.test/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body)).model).toBe(container.config.AI_MODEL);
    expect(res.body).not.toContain(SECRET);
  });

  it('falls back to the environment when a key is removed', async () => {
    provider();
    await put('AI_API_KEY', SECRET, firstMerchant);
    await app.inject({
      method: 'DELETE',
      url: '/api/settings/keys/AI_API_KEY',
      headers: headers(firstMerchant),
      payload: {},
    });
    expect(container.secrets.get('AI_API_KEY')).toBe('env-key-1234');
    expect(await statusOf('AI_API_KEY')).toMatchObject({ source: 'environment' });
  });

  it('refuses a key OpenAI rejects, and keeps the old one', async () => {
    provider(401);
    const res = await put('AI_API_KEY', 'sk-wrong', firstMerchant);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('sk-wrong');
    expect(container.secrets.get('AI_API_KEY')).toBe('env-key-1234');
  });

  it('saves when OpenAI cannot be reached, but says it was not verified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const res = await put('AI_API_KEY', SECRET, firstMerchant);
    expect(res.json()).toEqual({ saved: true, verified: false });
  });

  it('rejects values that could break an HTTP header, without echoing them', async () => {
    provider();
    const res = await put('AI_API_KEY', 'sk-abc\r\nx-evil: yes', firstMerchant);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('x-evil');
  });

  it('gives the licence key to the dashboard, but never the AI key', async () => {
    provider();
    await put('AI_API_KEY', SECRET, firstMerchant);
    await put('AG_STUDIO_LICENSE_KEY', LICENCE, firstMerchant);
    const res = await app.inject({ url: '/api/settings/client', headers: headers(firstMerchant) });
    expect(res.json()).toEqual({ aiEnabled: true, studioLicenseKey: LICENCE });
    expect(res.body).not.toContain(SECRET);
  });

  it('keeps other merchants out of keys for the whole installation', async () => {
    provider();
    const before = container.secrets.get('AI_API_KEY');
    expect((await put('AI_API_KEY', 'sk-hijack', otherShop)).statusCode).toBe(403);
    const list = await app.inject({ url: '/api/settings/keys', headers: headers(otherShop) });
    expect(list.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/settings/keys/AI_API_KEY',
      headers: headers(otherShop),
      payload: {},
    });
    expect(del.statusCode).toBe(403);
    expect(container.secrets.get('AI_API_KEY')).toBe(before);
  });

  it('keeps staff out', async () => {
    const username = `staff-${run}`;
    const staff = await container.dashboardUsers.create(
      firstMerchant,
      { username, name: 'Staff', role: 'STAFF', password: 'a-long-test-password-1' },
      'test',
    );
    const headersFor = { ...auth, 'x-dashboard-user': staff.id, 'x-dashboard-session': '1' };
    const res = await app.inject({ url: '/api/settings/keys', headers: headersFor });
    await container.db.dashboardUser.delete({ where: { id: staff.id } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses without the service token, and for unknown key names', async () => {
    expect((await app.inject({ url: '/api/settings/keys' })).statusCode).toBe(401);
    expect((await put('PAYPAL_CLIENT_SECRET', 'x', firstMerchant)).statusCode).toBe(404);
  });

  it('treats a key it can no longer read as unset and says it needs re-entering', async () => {
    await container.db.appSecret.upsert({
      where: { name: 'AI_API_KEY' },
      create: { name: 'AI_API_KEY', ciphertext: 'v1.bad.bad.bad', hint: 'XXXX', updatedBy: 't' },
      update: { ciphertext: 'v1.bad.bad.bad' },
    });
    await container.secrets.refresh();
    expect(container.secrets.get('AI_API_KEY')).toBe('env-key-1234');
    expect(await statusOf('AI_API_KEY')).toMatchObject({ source: 'environment', unreadable: true });
  });
});
