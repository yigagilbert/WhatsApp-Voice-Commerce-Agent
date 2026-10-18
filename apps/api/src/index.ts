import { ConfigError, loadApiConfig, type ApiConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { buildApp } from './app';
import { createContainer } from './container';

async function main() {
  let config: ApiConfig;
  try {
    config = loadApiConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({
    name: 'api',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });
  const container = createContainer(config, logger);
  const app = await buildApp(container);

  logger.info(
    {
      ai: container.chatModel?.id ?? 'not configured',
      speech: container.speech ? 'configured' : 'not configured',
      paypal: container.paypal.configured ? config.PAYPAL_ENV : 'not configured',
      whatsappGateway: config.WHATSAPP_GATEWAY_URL ?? 'not configured',
    },
    'providers',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await container.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  // Proactive WhatsApp reports (one API instance; duplicate slots are prevented in the database).
  if (config.REPORT_SCHEDULER_ENABLED) {
    container.reportScheduler.start();
    // Same single instance: watches the WhatsApp worker and reports outages once it's back.
    container.whatsappMonitor.start();
    logger.info('report scheduler started');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
