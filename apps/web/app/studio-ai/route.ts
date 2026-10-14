import { loadWebConfig } from '@vca/config';
import { currentUser } from '@/lib/auth';
import { toChatCompletion, type StudioTurnRequest, type StudioTurnResult } from '@/lib/studio-llm';

/**
 * Server-side LLM proxy for AG Studio's analytics assistant. The browser never sees the
 * provider key: AG Studio's adapter posts one turn here, we forward it to the configured
 * OpenAI-compatible model and return the reply and any tool calls. AG Studio then runs its
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

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return fail(401, 'unauthorized', 'Sign in to use the analytics assistant.');
  if (!allow(user)) return fail(429, 'rate_limited', 'Too many requests. Please wait a moment.');

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'Request too large.');
  let turn: StudioTurnRequest;
  try {
    turn = JSON.parse(raw) as StudioTurnRequest;
  } catch {
    return fail(400, 'bad_request', 'Invalid request.');
  }
  if (!Array.isArray(turn.input)) return fail(400, 'bad_request', 'Invalid request.');

  const config = loadWebConfig();
  if (!config.AI_API_KEY)
    return fail(503, 'not_configured', 'The analytics assistant is not configured (AI_API_KEY).');

  const body = toChatCompletion(turn, config.AI_MODEL);
  try {
    const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.AI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(config.AI_TIMEOUT_MS, 60_000)),
    });
    const json = (await response.json().catch(() => null)) as {
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
    } | null;
    if (!response.ok || !json?.choices?.[0]) {
      console.warn(`studio-ai: provider responded ${response.status}`);
      return fail(502, 'provider_error', 'The AI provider is temporarily unavailable.');
    }
    const choice = json.choices[0];
    const result: StudioTurnResult = {
      id: json.id ?? crypto.randomUUID(),
      model: json.model ?? config.AI_MODEL,
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
  } catch {
    return fail(504, 'timeout', 'The AI provider did not respond in time.');
  }
}
