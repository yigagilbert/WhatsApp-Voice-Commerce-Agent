import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  generateConfirmationCode,
  hashPayload,
  parseConfirmationReply,
  requiresConfirmation,
} from './confirmation';

describe('parseConfirmationReply', () => {
  it.each([
    ['yes', { kind: 'confirm', verb: 'confirm' }],
    ['Yes!', { kind: 'confirm', verb: 'confirm' }],
    ['  CONFIRM 4821 ', { kind: 'confirm', code: '4821', verb: 'confirm' }],
    ['go ahead', { kind: 'confirm', verb: 'confirm' }],
    ['ok 1234', { kind: 'confirm', code: '1234', verb: 'confirm' }],
    ['Yee', { kind: 'confirm', verb: 'confirm' }],
    ['SHIP 8314', { kind: 'confirm', code: '8314', verb: 'ship' }],
    ['submit 7312.', { kind: 'confirm', code: '7312', verb: 'submit' }],
    ['cancel', { kind: 'cancel' }],
    ['No.', { kind: 'cancel' }],
    ['nedda', { kind: 'cancel' }],
  ])('recognises %j', (text, expected) => {
    expect(parseConfirmationReply(text)).toEqual(expected);
  });

  it.each([
    'yes but make it 40 baskets',
    'how much is that?',
    'confirm the order for James',
    '4821',
    'yesterday',
    'ship',
    'submit it',
    'ship ORD-1042 with DHL',
  ])('leaves %j to the agent', (text) => {
    expect(parseConfirmationReply(text)).toBeNull();
  });
});

describe('payload hashing', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
    expect(hashPayload({ orderId: 'o1', totalMinor: 68000 })).toBe(
      hashPayload({ totalMinor: 68000, orderId: 'o1' }),
    );
  });

  it('changes when the amount changes', () => {
    expect(hashPayload({ orderId: 'o1', totalMinor: 68000 })).not.toBe(
      hashPayload({ orderId: 'o1', totalMinor: 68001 }),
    );
  });
});

describe('policy', () => {
  it('requires confirmation for every financial action', () => {
    expect(requiresConfirmation('CREATE_PAYMENT_REQUEST')).toBe(true);
    expect(requiresConfirmation('REFUND_PAYMENT')).toBe(true);
  });

  it('generates 4-digit codes', () => {
    expect(generateConfirmationCode()).toMatch(/^\d{4}$/);
  });
});
