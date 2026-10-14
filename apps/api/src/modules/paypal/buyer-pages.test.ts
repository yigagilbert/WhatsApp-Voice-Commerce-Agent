import { describe, expect, it } from 'vitest';
import { renderBuyerPage } from './buyer-pages';

describe('renderBuyerPage', () => {
  it('shows the order, amount and status the buyer needs', () => {
    const html = renderBuyerPage({
      tone: 'success',
      title: 'Payment successful',
      message: 'Thank you! Your payment has been received.',
      details: { merchant: 'Kampala Crafts', reference: 'ORD-ABC123', amount: '$140.00' },
      sandbox: true,
    });
    expect(html).toContain('<title>Payment successful · Katale AI</title>');
    expect(html).toContain('<dd>ORD-ABC123</dd>');
    expect(html).toContain('<dd>$140.00</dd>');
    expect(html).toContain('PayPal Sandbox · test payment');
    expect(html).toContain('noindex');
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes merchant-controlled text', () => {
    const html = renderBuyerPage({
      tone: 'neutral',
      title: 'Payment not completed',
      message: 'No money was taken.',
      details: { merchant: '<img src=x onerror=alert(1)>' },
      action: { label: 'Return to PayPal', href: 'https://www.sandbox.paypal.com/x?a=1&b="2"' },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="https://www.sandbox.paypal.com/x?a=1&amp;b=&quot;2&quot;"');
    expect(html).not.toContain('PayPal Sandbox · test payment');
  });
});
