/**
 * pnpm ai:check — verifies the configured OpenAI-compatible endpoint answers and supports
 * native tool calling (which the agent requires). Prints no secrets.
 */
import { OpenAICompatibleChatModel } from '@vca/ai';
import { aiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { isAppError } from '@vca/shared';

loadEnvFile();

async function main() {
  const config = parseConfig(aiSchema);
  console.log(`Provider: ${config.AI_PROVIDER}`);
  console.log(`Base URL: ${config.AI_BASE_URL}`);
  console.log(`Model: ${config.AI_MODEL}`);
  if (!config.AI_API_KEY) {
    console.error('AI_API_KEY: MISSING');
    process.exitCode = 1;
    return;
  }
  const model = new OpenAICompatibleChatModel({
    baseUrl: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  const started = Date.now();
  try {
    const { message, usage } = await model.complete({
      messages: [
        { role: 'system', content: 'You are a test harness. Always use the provided tool.' },
        { role: 'user', content: 'Look up the stock for the product "Handmade Basket".' },
      ],
      tools: [
        {
          name: 'check_inventory',
          description: 'Check stock for a product by name.',
          parameters: {
            type: 'object',
            properties: { product_name: { type: 'string' } },
            required: ['product_name'],
          },
        },
      ],
    });
    const call = message.toolCalls?.[0];
    console.log(
      `\nAI authentication: OK (${Date.now() - started} ms${usage ? `, ${usage.inputTokens}+${usage.outputTokens} tokens` : ''})`,
    );
    if (call?.name === 'check_inventory') {
      console.log(`Tool calling: SUPPORTED (arguments: ${call.arguments})`);
    } else {
      console.error(
        'Tool calling: NOT DETECTED — the model answered with text instead of a tool call.',
      );
      console.error(
        'The agent requires native tool calling; choose a model/endpoint that supports `tools`.',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('\nAI check: FAILED');
    console.error(
      isAppError(error) ? `${error.message} ${JSON.stringify(error.details ?? '')}` : error,
    );
    if (isAppError(error) && /tool/i.test(JSON.stringify(error.details ?? ''))) {
      console.error(
        'The endpoint appears to reject the `tools` parameter (no native tool calling).',
      );
    }
    process.exitCode = 1;
  }
}

void main();
