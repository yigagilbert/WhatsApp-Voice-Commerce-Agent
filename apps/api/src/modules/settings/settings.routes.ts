import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError, NotFoundError, ValidationError } from '@vca/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { actorLabel, ownerOnly } from '../../http/merchant-scope';
import { parse } from '../../http/validation';
import { isSecretName, type SecretName } from './app-secrets.service';

const MAX_ASSISTANT_BYTES = 512 * 1024;
const KEY_CHECK_TIMEOUT_MS = 10_000;

/**
 * These keys serve the whole installation, so they belong to the owners of the installation's first
 * merchant, the one the seed or setup created. Owners of any other shop can't read or change them:
 * replacing the AI key would send every shop's conversations to an account of their choosing.
 */
async function platformOwnerOnly(request: FastifyRequest, container: Container) {
  await ownerOnly(request);
  const first = await container.db.merchant.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (first?.id !== request.merchant.id)
    throw new ForbiddenError('API keys are managed by the owner of this Katale installation.');
}

const secretName = (request: FastifyRequest): SecretName => {
  const { name } = request.params as { name: string };
  if (!isSecretName(name)) throw new NotFoundError('API key', name);
  return name;
};

/** Asks the AI provider whether it accepts a key. Only a definite refusal stops a save. */
async function checkAiKey(baseUrl: string, key: string): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return 'rejected';
    return response.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function settingsRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  const { secrets, audit, config } = container;

  /** What the dashboard needs to render. The licence key goes to the browser, as AG Studio requires. */
  app.get('/api/settings/client', async () => ({
    aiEnabled: !!secrets.get('AI_API_KEY'),
    studioLicenseKey: secrets.get('AG_STUDIO_LICENSE_KEY') ?? null,
  }));

  /** Status only: no route ever returns a key's value. */
  app.get('/api/settings/keys', async (request) => {
    await platformOwnerOnly(request, container);
    return secrets.status();
  });

  app.put('/api/settings/keys/:name', async (request) => {
    await platformOwnerOnly(request, container);
    const name = secretName(request);
    const { value: raw } = parse(z.object({ value: z.string() }), request.body);
    const value = secrets.normalize(name, raw);
    const check = name === 'AI_API_KEY' ? await checkAiKey(config.AI_BASE_URL, value) : 'unknown';
    if (check === 'rejected')
      throw new ValidationError('OpenAI rejected this key. Check it and try again.');
    const by = actorLabel(request);
    await secrets.save(name, value, by);
    await audit.record({
      merchantId: request.merchant.id,
      actor: 'MERCHANT',
      type: 'settings.key_saved',
      entityType: 'api_key',
      entityId: name,
      data: { by },
    });
    return { saved: true, verified: check === 'ok' };
  });

  app.delete('/api/settings/keys/:name', async (request) => {
    await platformOwnerOnly(request, container);
    const name = secretName(request);
    const by = actorLabel(request);
    await secrets.remove(name);
    await audit.record({
      merchantId: request.merchant.id,
      actor: 'MERCHANT',
      type: 'settings.key_removed',
      entityType: 'api_key',
      entityId: name,
      data: { by },
    });
    return { removed: true };
  });

  /**
   * One turn of the Overview assistant, forwarded to the AI provider with the key added here, so the
   * key never reaches the web tier. The dashboard server has already checked the user and their
   * rate limit. The model is fixed by this server's configuration, not the request.
   */
  app.post('/api/settings/assistant-turn', { bodyLimit: MAX_ASSISTANT_BYTES }, async (request) => {
    const key = secrets.get('AI_API_KEY');
    if (!key) return { ok: false, code: 'not_configured' };
    const body = { ...(request.body as object), model: config.AI_MODEL };
    try {
      const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(config.AI_TIMEOUT_MS, 60_000)),
      });
      const completion: unknown = await response.json().catch(() => null);
      if (!response.ok || !completion) {
        request.log.warn({ status: response.status }, 'assistant provider error');
        return { ok: false, code: 'provider_error' };
      }
      return { ok: true, completion };
    } catch {
      return { ok: false, code: 'timeout' };
    }
  });
}
