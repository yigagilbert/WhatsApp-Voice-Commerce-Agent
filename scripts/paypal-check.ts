/**
 * pnpm paypal:check — verifies PayPal credentials by requesting an OAuth token.
 * Prints no secrets: only the environment, app ID and token lifetime.
 */
import { loadEnvFile, parseConfig, paypalSchema } from '@vca/config';
import { PayPalClient } from '@vca/paypal';
import { isAppError } from '@vca/shared';

loadEnvFile();

async function main() {
  const config = parseConfig(paypalSchema);
  const env = config.PAYPAL_ENV;
  console.log(`Environment: ${env}`);
  console.log(`PAYPAL_CLIENT_ID: ${config.PAYPAL_CLIENT_ID ? 'set' : 'MISSING'}`);
  console.log(`PAYPAL_CLIENT_SECRET: ${config.PAYPAL_CLIENT_SECRET ? 'set' : 'MISSING'}`);
  console.log(
    `PAYPAL_WEBHOOK_ID: ${config.PAYPAL_WEBHOOK_ID ? 'set' : 'not set (webhooks will be rejected)'}`,
  );

  const client = new PayPalClient({
    environment: env,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  });
  try {
    const result = await client.checkCredentials();
    console.log(`\nPayPal ${env === 'sandbox' ? 'Sandbox' : 'LIVE'} authentication: OK`);
    if (result.appId) console.log(`App ID: ${result.appId}`);
    console.log(`Token lifetime: ${Math.round(result.expiresInSeconds / 60)} minutes`);
    if (env === 'live')
      console.warn('\n⚠️  PAYPAL_ENV=live — this project should use sandbox during development.');
  } catch (error) {
    console.error(`\nPayPal ${env} authentication: FAILED`);
    console.error(isAppError(error) ? error.message : error);
    if (isAppError(error) && /invalid_client/i.test(error.message)) {
      console.error(
        `Hint: check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, and that they are ${env} credentials ` +
          '(Sandbox and Live apps have different credentials).',
      );
    }
    process.exitCode = 1;
  }
}

void main();
