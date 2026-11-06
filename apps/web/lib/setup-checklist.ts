import { isPayPalSupportedCurrency, normalizeCurrency } from '@vca/commerce/money';

/** Null when PayPal can take payment in this currency; otherwise what the merchant must know. */
export function payPalCurrencyProblem(currency: string | null | undefined): string | null {
  if (!currency) return null;
  try {
    if (isPayPalSupportedCurrency(currency)) return null;
    return `PayPal doesn't accept ${normalizeCurrency(currency)}, so customers can't pay online. Price in USD or another PayPal currency.`;
  } catch {
    return null;
  }
}

export interface SetupFacts {
  whatsappLinked: boolean;
  hasActiveAdmin: boolean;
  hasProductWithPhoto: boolean;
  /** Offered on this server at all (CUSTOMER_COMMERCE_ENABLED). */
  customerShoppingAvailable: boolean;
  customerShoppingOn: boolean;
  /** Delivery or pick-up is on, so a customer has a way to receive an order. */
  fulfilmentOn: boolean;
  storefrontPublished: boolean;
  /** Why the storefront can't send customers to WhatsApp, if anything. */
  checkoutBlocker: string | null;
  /** False only when the server reports PayPal isn't set up; null when that couldn't be read. */
  paypalConfigured: boolean | null;
  currency: string | null;
  orders: number;
  paidOrders: number;
}

export interface SetupStep {
  done: boolean;
  title: string;
  detail: string;
  href: string;
  action: string;
}

export interface Setup {
  steps: SetupStep[];
  /** Things no step can tick off that still stop customers paying. */
  blockers: string[];
  /** Customers can browse, order and pay. First-order and first-payment steps may still be open. */
  ready: boolean;
  remaining: number;
}

/**
 * The steps between an empty shop and a first paid order. "Ready to sell" means everything a
 * customer's order depends on is in place; the last two steps are that order actually happening.
 */
export function buildSetup(facts: SetupFacts): Setup {
  const shoppingStep: SetupStep = facts.customerShoppingAvailable
    ? {
        done: facts.customerShoppingOn,
        title: 'Turn on customer shopping',
        detail: 'Lets customers browse, order and pay in a chat with your number.',
        href: '/whatsapp',
        action: 'Open WhatsApp',
      }
    : {
        done: false,
        title: 'Turn on customer shopping',
        detail: "Customer shopping isn't available on this Katale service yet. Ask who runs it.",
        href: '/whatsapp',
        action: 'Open WhatsApp',
      };
  const requirements: SetupStep[] = [
    {
      done: facts.whatsappLinked,
      title: 'Link your WhatsApp number',
      detail: 'Scan the pairing code so Katale AI can receive and send messages.',
      href: '/whatsapp',
      action: 'Open WhatsApp',
    },
    {
      done: facts.hasActiveAdmin,
      title: 'Add an admin number',
      detail: 'Only admin numbers can create orders, payment links and reports by chat.',
      href: '/admins',
      action: 'Add admin',
    },
    {
      done: facts.hasProductWithPhoto,
      title: 'Add a product with a photo',
      detail: 'Name, price, stock and a photo. Customers see the photo on WhatsApp.',
      href: '/products/new',
      action: 'Add product',
    },
    shoppingStep,
    {
      done: facts.fulfilmentOn,
      title: 'Set up delivery or pick-up',
      detail: 'Customers choose one at checkout, so at least one has to be on.',
      href: '/whatsapp',
      action: 'Open WhatsApp',
    },
    {
      done: facts.storefrontPublished && !facts.checkoutBlocker,
      title: 'Publish your storefront',
      detail:
        facts.storefrontPublished && facts.checkoutBlocker
          ? `Customers can browse but can't check out yet. ${facts.checkoutBlocker}`
          : 'Gives you a link and QR code to share. Customers browse there and order on WhatsApp.',
      href: '/storefront',
      action: 'Open storefront',
    },
  ];
  const milestones: SetupStep[] = [
    {
      done: facts.orders > 0,
      title: 'Create your first order',
      detail: 'Send “2 baskets for Sarah” by text or voice note, or try the Agent console.',
      href: '/console',
      action: 'Open console',
    },
    {
      done: facts.paidOrders > 0,
      title: 'Get paid with PayPal',
      detail: 'Approve the payment link; the order updates when PayPal confirms the payment.',
      href: '/orders',
      action: 'View orders',
    },
  ];
  const currencyProblem = payPalCurrencyProblem(facts.currency);
  const blockers = [
    ...(currencyProblem ? [currencyProblem] : []),
    ...(facts.paypalConfigured === false
      ? ["PayPal isn't set up on this Katale service yet, so customers can't pay online."]
      : []),
  ];
  const steps = [...requirements, ...milestones];
  return {
    steps,
    blockers,
    ready: requirements.every((step) => step.done) && blockers.length === 0,
    remaining: steps.filter((step) => !step.done).length,
  };
}
