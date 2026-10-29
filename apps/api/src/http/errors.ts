import type { FastifyError, FastifyInstance } from 'fastify';
import { ProviderError, isAppError } from '@vca/shared';

const PROVIDER_NAMES: Record<string, string> = { paypal: 'PayPal', llm: 'The AI service' };

/** Maps every error to a stable JSON shape: { error: { code, message, details? }, correlationId }. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const correlationId = request.id;

    if (isAppError(error)) {
      if (error.httpStatus >= 500) request.log.error({ err: error }, error.message);
      else request.log.info({ code: error.code }, error.message);
      // Provider internals (status names, issue codes) stay in the logs; the dashboard gets a plain
      // sentence plus the correlation ID to find them.
      const message =
        error instanceof ProviderError
          ? `${PROVIDER_NAMES[error.provider] ?? 'An external service'} could not complete this right now. Please try again in a few minutes (reference ${correlationId}).`
          : error.message;
      return reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message,
          ...(error.details !== undefined && error.httpStatus < 500
            ? { details: error.details }
            : {}),
        },
        correlationId,
      });
    }

    // Fastify's own 4xx errors (malformed JSON, body too large, rate limit, ...).
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
        correlationId,
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      correlationId,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
      correlationId: request.id,
    }),
  );
}
