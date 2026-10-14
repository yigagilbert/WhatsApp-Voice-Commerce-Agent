import { ProviderError, ProviderNotConfiguredError, type Logger } from '@vca/shared';
import {
  PAYPAL_BASE_URLS,
  type AddTrackingParams,
  type CreateCheckoutOrderParams,
  type DisputeEvidence,
  type PayPalDispute,
  type PayPalDisputeSummary,
  type CreateInvoiceParams,
  type PayPalApi,
  type PayPalEnvironment,
  type PayPalInvoice,
  type PayPalOrder,
  type WebhookSignatureHeaders,
} from './types';

export interface PayPalClientOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  environment: PayPalEnvironment;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger?: Logger;
}

interface PayPalErrorBody {
  /** REST API errors (Orders, Invoicing, ...). */
  name?: string;
  message?: string;
  /** OAuth errors use the RFC 6749 shape instead, e.g. { error: "invalid_client" }. */
  error?: string;
  error_description?: string;
  debug_id?: string;
  details?: { issue?: string; description?: string }[];
}

/** HTTP status of a PayPal ProviderError, if any. */
export function payPalErrorStatus(error: unknown): number | undefined {
  return error instanceof ProviderError
    ? (error.details as { status?: number } | undefined)?.status
    : undefined;
}

/** PayPal issue codes (e.g. "ORDER_ALREADY_CAPTURED") carried by a ProviderError. */
export function payPalErrorIssues(error: unknown): string[] {
  return error instanceof ProviderError
    ? ((error.details as { issues?: string[] } | undefined)?.issues ?? [])
    : [];
}

/**
 * Thin, typed PayPal REST client (OAuth2 client-credentials, Orders v2, Invoicing v2,
 * webhook signature verification). Every mutating call carries a PayPal-Request-Id so
 * retries are idempotent on PayPal's side.
 *
 * This is the ONLY code that talks to PayPal. It is called by the API's payment service
 * after server-side validation and merchant confirmation — never directly by the LLM.
 */
export class PayPalClient implements PayPalApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: PayPalClientOptions) {
    this.baseUrl = PAYPAL_BASE_URLS[options.environment];
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    return (await this.fetchToken()).accessToken;
  }

  /**
   * Requests a fresh OAuth token. Used by `accessToken()` and by `pnpm paypal:check`.
   * The token itself is never logged or returned to callers outside this class.
   */
  async checkCredentials(): Promise<{
    appId?: string;
    expiresInSeconds: number;
    environment: PayPalEnvironment;
  }> {
    const { expiresIn, appId } = await this.fetchToken();
    return {
      expiresInSeconds: expiresIn,
      environment: this.options.environment,
      ...(appId ? { appId } : {}),
    };
  }

  private async fetchToken(): Promise<{ accessToken: string; expiresIn: number; appId?: string }> {
    const { clientId, clientSecret } = this.options;
    if (!clientId || !clientSecret) {
      throw new ProviderNotConfiguredError(
        'PayPal',
        'set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET',
      );
    }
    const response = await this.send(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const json = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      app_id?: string;
    };
    if (!json.access_token) throw new ProviderError('paypal', 'token response had no access_token');
    const expiresIn = json.expires_in ?? 300;
    // Refresh a minute early to avoid using a token that expires mid-request.
    this.token = { value: json.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    return {
      accessToken: json.access_token,
      expiresIn,
      ...(json.app_id ? { appId: json.app_id } : {}),
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (cause) {
      throw new ProviderError('paypal', 'request failed', { cause });
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as PayPalErrorBody;
      const name = body.name ?? body.error ?? `HTTP_${response.status}`;
      const message = body.message ?? body.error_description ?? 'request failed';
      const issues = body.details?.map((d) => d.issue).filter((i): i is string => !!i) ?? [];
      // Safe to log: PayPal error bodies contain no credentials. debug_id helps PayPal support.
      this.options.logger?.warn(
        {
          status: response.status,
          name,
          debugId: body.debug_id,
          issues,
          path: new URL(url).pathname,
        },
        'paypal request failed',
      );
      throw new ProviderError('paypal', `${name}: ${message}`, {
        details: { status: response.status, name, debugId: body.debug_id, issues },
      });
    }
    return response;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    requestId?: string,
    retried = false,
  ): Promise<T> {
    try {
      const response = await this.send(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
          ...(requestId ? { 'paypal-request-id': requestId } : {}),
        },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      });
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      // A cached token can be revoked before it expires: refresh once and retry.
      // Safe for POSTs because the same PayPal-Request-Id is resent.
      if (!retried && this.token && payPalErrorStatus(error) === 401) {
        this.token = null;
        return this.request<T>(method, path, body, requestId, true);
      }
      throw error;
    }
  }

  async createCheckoutOrder(
    params: CreateCheckoutOrderParams,
  ): Promise<{ order: PayPalOrder; approveUrl: string }> {
    const money = (value: string) => ({ currency_code: params.currency, value });
    const order = await this.request<PayPalOrder>(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: params.referenceId,
            custom_id: params.customId,
            ...(params.description ? { description: params.description.slice(0, 127) } : {}),
            amount: {
              ...money(params.total),
              breakdown: {
                item_total: money(params.itemTotal),
                shipping: money(params.shipping),
                tax_total: money(params.taxTotal),
              },
            },
            items: params.items.map((item) => ({
              name: item.name.slice(0, 127),
              quantity: String(item.quantity),
              unit_amount: money(item.unitAmount),
            })),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: params.brandName.slice(0, 127),
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: params.returnUrl,
              cancel_url: params.cancelUrl,
            },
          },
        },
      },
      params.requestId,
    );
    // With payment_source.paypal PayPal returns a "payer-action" link; older flows use "approve".
    const approveUrl = order.links?.find(
      (l) => l.rel === 'payer-action' || l.rel === 'approve',
    )?.href;
    if (!approveUrl) throw new ProviderError('paypal', `order ${order.id} has no approval link`);
    return { order, approveUrl };
  }

  getOrder(orderId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId: string, requestId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {},
      requestId,
    );
  }

  /**
   * Orders v2 tracking (POST /v2/checkout/orders/{id}/track). PayPal makes this idempotent on
   * capture_id + tracking_number: a repeat returns 200 with the existing tracker, not a new one.
   * The capture must be COMPLETED (otherwise 422 CAPTURE_STATUS_NOT_VALID).
   */
  addTracking(params: AddTrackingParams): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(params.paypalOrderId)}/track`,
      {
        capture_id: params.captureId,
        tracking_number: params.trackingNumber,
        carrier: params.carrier,
        ...(params.carrier === 'OTHER' && params.carrierNameOther
          ? { carrier_name_other: params.carrierNameOther }
          : {}),
        notify_payer: params.notifyPayer ?? false,
      },
    );
  }

  async listDisputes(params: { pageSize?: number } = {}): Promise<PayPalDisputeSummary[]> {
    const result = await this.request<{ items?: PayPalDisputeSummary[] }>(
      'GET',
      `/v1/customer/disputes?page_size=${params.pageSize ?? 20}`,
    );
    return result.items ?? [];
  }

  getDispute(disputeId: string): Promise<PayPalDispute> {
    return this.request<PayPalDispute>(
      'GET',
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}`,
    );
  }

  /**
   * Disputes v1 provide-evidence. The endpoint takes multipart/form-data: an `input` part with
   * the evidences JSON (files are optional; Katale sends structured evidence and notes only).
   */
  async provideDisputeEvidence(disputeId: string, evidences: DisputeEvidence[]): Promise<void> {
    const form = new FormData();
    form.append(
      'input',
      new Blob([JSON.stringify({ evidences })], { type: 'application/json' }),
      'input.json',
    );
    await this.send(
      `${this.baseUrl}/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}` },
        body: form,
      },
    );
  }

  /** SANDBOX ONLY: moves an UNDER_REVIEW dispute to WAITING_FOR_SELLER_RESPONSE (test tooling). */
  async sandboxRequireSellerEvidence(disputeId: string): Promise<void> {
    if (this.options.environment !== 'sandbox')
      throw new ProviderError('paypal', 'require-evidence is sandbox-only');
    await this.request(
      'POST',
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}/require-evidence`,
      {
        action: 'SELLER_EVIDENCE',
      },
    );
  }

  /** Replaces the event types of an existing webhook (admin tooling). */
  updateWebhookEvents(webhookId: string, eventTypes: readonly string[]) {
    return this.request<{ id: string; event_types: { name: string }[] }>(
      'PATCH',
      `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`,
      [{ op: 'replace', path: '/event_types', value: eventTypes.map((name) => ({ name })) }],
    );
  }

  createDraftInvoice(params: CreateInvoiceParams): Promise<PayPalInvoice> {
    const money = (value: string) => ({ currency_code: params.currency, value });
    return this.request<PayPalInvoice>(
      'POST',
      '/v2/invoicing/invoices',
      {
        detail: {
          currency_code: params.currency,
          ...(params.invoiceNumber ? { invoice_number: params.invoiceNumber } : {}),
          ...(params.note ? { note: params.note } : {}),
          payment_term: { term_type: 'DUE_ON_RECEIPT' },
        },
        invoicer: { business_name: params.businessName },
        primary_recipients: [
          {
            billing_info: {
              name: {
                given_name: params.recipient.givenName,
                ...(params.recipient.surname ? { surname: params.recipient.surname } : {}),
              },
              email_address: params.recipient.email,
            },
          },
        ],
        items: params.items.map((item) => ({
          name: item.name.slice(0, 200),
          quantity: String(item.quantity),
          unit_amount: money(item.unitAmount),
          unit_of_measure: 'QUANTITY',
        })),
        ...(params.shipping
          ? { amount: { breakdown: { shipping: { amount: money(params.shipping) } } } }
          : {}),
      },
      params.requestId,
    );
  }

  sendInvoice(invoiceId: string, requestId: string): Promise<{ href?: string }> {
    return this.request<{ href?: string }>(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
      { send_to_invoicer: false, send_to_recipient: true },
      requestId,
    );
  }

  /** Webhooks registered for this REST app (admin tooling: `pnpm paypal:webhook`). */
  async listWebhooks(): Promise<{ id: string; url: string; event_types: { name: string }[] }[]> {
    const result = await this.request<{
      webhooks?: { id: string; url: string; event_types: { name: string }[] }[];
    }>('GET', '/v1/notifications/webhooks');
    return result.webhooks ?? [];
  }

  /** Registers a webhook URL for the given event types; returns PayPal's webhook ID. */
  async createWebhook(url: string, eventTypes: readonly string[]): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/v1/notifications/webhooks', {
      url,
      event_types: eventTypes.map((name) => ({ name })),
    });
  }

  /**
   * Verifies a webhook via PayPal's verify-webhook-signature API.
   * The original raw body is spliced in verbatim: re-serialising parsed JSON can change
   * bytes (key order, number formatting) and make verification fail.
   */
  async verifyWebhookSignature(params: {
    headers: WebhookSignatureHeaders;
    rawBody: string;
    webhookId: string;
  }): Promise<boolean> {
    const h = params.headers;
    const body =
      `{"auth_algo":${JSON.stringify(h.authAlgo)},"cert_url":${JSON.stringify(h.certUrl)},` +
      `"transmission_id":${JSON.stringify(h.transmissionId)},"transmission_sig":${JSON.stringify(h.transmissionSig)},` +
      `"transmission_time":${JSON.stringify(h.transmissionTime)},"webhook_id":${JSON.stringify(params.webhookId)},` +
      `"webhook_event":${params.rawBody}}`;
    const result = await this.request<{ verification_status?: string }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      body,
    );
    return result.verification_status === 'SUCCESS';
  }
}
