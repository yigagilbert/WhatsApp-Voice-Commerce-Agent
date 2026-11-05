import { apiPost } from '@/lib/api';
import { currentUser } from '@/lib/auth';
import { toChatCompletion, type StudioTurnRequest, type StudioTurnResult } from '@/lib/studio-llm';

/**
 * Server-side LLM proxy for the Overview assistant. Neither the browser nor this server holds the
 * provider key: AG Studio's adapter posts one turn here, we check the user and forward it through
 * the API, which adds the key, and return the reply and any tool calls. AG Studio then runs its
 * own structured tools (schema, query, add widget) in the browser — the model never writes code.
 *
 * Not under /api: the public proxy only routes /api/paypal/* and /api/health to the API.
 */
const MAX_BODY_BYTES = 512 * 1024;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TURNS_PER_WINDOW = 120;
const turns = new Map<string, number[]>();

function allow(user: string, now = Date.now()): boolean {
  const recent = (turns.get(user) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_TURNS_PER_WINDOW) return false;
  recent.push(now);
  turns.set(user, recent);
  return true;
}

interface Completion {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

type ProviderReply = { ok: true; completion: Completion } | { ok: false; code: string };

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return fail(401, 'unauthorized', 'Sign in to use the analytics assistant.');
  if (!allow(user.id)) return fail(429, 'rate_limited', 'Too many requests. Please wait a moment.');

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'Request too large.');
  let turn: StudioTurnRequest;
  try {
    turn = JSON.parse(raw) as StudioTurnRequest;
  } catch {
    return fail(400, 'bad_request', 'Invalid request.');
  }
  if (!Array.isArray(turn.input)) return fail(400, 'bad_request', 'Invalid request.');

  // The API adds the key and the configured model, so neither is held here.
  const forwarded = await apiPost<ProviderReply>(
    '/api/settings/assistant-turn',
    toChatCompletion(turn, 'configured-by-api'),
  );
  if (!forwarded.ok)
    return fail(502, 'provider_error', 'The AI provider is temporarily unavailable.');
  const reply = forwarded.data;
  if (!reply.ok) {
    if (reply.code === 'not_configured')
      return fail(
        503,
        'not_configured',
        'The assistant needs an OpenAI key. Add one on the API keys page.',
      );
    if (reply.code === 'timeout')
      return fail(504, 'timeout', 'The AI provider did not respond in time.');
    return fail(502, 'provider_error', 'The AI provider is temporarily unavailable.');
  }
  const json = reply.completion;
  const choice = json.choices?.[0];
  if (!choice) return fail(502, 'provider_error', 'The AI provider is temporarily unavailable.');
  const result: StudioTurnResult = {
    id: json.id ?? crypto.randomUUID(),
    model: json.model ?? 'unknown',
    text: choice.message?.content ?? '',
    toolCalls: (choice.message?.tool_calls ?? []).map((c) => ({
      callId: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    })),
    incomplete: choice.finish_reason === 'length',
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
  };
  return Response.json(result);
}
