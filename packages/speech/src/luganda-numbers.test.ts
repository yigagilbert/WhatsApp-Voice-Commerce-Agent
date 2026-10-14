import { describe, expect, it } from 'vitest';
import { normalizeLugandaNumbers as n } from './luganda-numbers';

describe('normalizeLugandaNumbers', () => {
  it('fixes the production case: "dollar abiri" is 20, "kkumi na bbiri" is 12', () => {
    expect(
      n(
        'Kola HB order eya ssaala ayagala HB kkumi buli emu ku dollar kkumi na bbiri otegeko ne Shipping price ya dollar abiri.',
      ),
    ).toBe(
      'Kola HB order eya ssaala ayagala HB 10 buli 1 ku dollar 12 otegeko ne Shipping price ya dollar 20.',
    );
  });

  it.each([
    ['ebisero ttaano', 'ebisero 5'],
    ['doola bbiri', 'doola 2'],
    ['amakumi abiri', '20'],
    ['amakumi ana', '40'],
    ['amakumi abiri mu ttaano', '25'],
    ['kkumi na mwenda', '19'],
    ['kikumi', '100'],
    ['bibiri mu amakumi ataano', '250'],
    ['lukumi', '1000'],
  ])('%s → %s', (input, expected) => {
    expect(n(input)).toBe(expected);
  });

  it('leaves "ana" alone outside "amakumi ana" and keeps other words intact', () => {
    expect(n('omwana ana sente')).toBe('omwana ana sente');
    expect(n('Odda ki ze tulina mu sitooku?')).toBe('Odda ki ze tulina mu sitooku?');
  });
});
