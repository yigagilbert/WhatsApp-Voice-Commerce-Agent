'use server';

import { randomUUID } from 'node:crypto';
import { apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

interface AgentResponse {
  status: string;
  replies: { text: string }[];
}

/**
 * Sends a message to the agent as the "web" channel. Runs on the server so the
 * dashboard token never reaches the browser.
 */
export async function sendConsoleMessage(
  text: string,
): Promise<{ ok: true; replies: string[] } | { ok: false; error: string }> {
  await requireUser(); // also enforced by proxy.ts and apiPost; checked here explicitly
  const trimmed = text.trim().slice(0, 4000);
  if (!trimmed) return { ok: false, error: 'Message is empty' };
  const result = await apiPost<AgentResponse>('/api/agent/message', {
    channel: 'web',
    externalMessageId: randomUUID(),
    externalChatId: 'dashboard',
    senderId: 'dashboard',
    sentAt: new Date().toISOString(),
    type: 'text',
    text: trimmed,
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.data.status === 'ignored') {
    return {
      ok: false,
      error: 'The API ignored this message — run `pnpm db:seed` to create the dashboard operator.',
    };
  }
  return { ok: true, replies: result.data.replies.map((r) => r.text) };
}
