/**
 * Deterministic Luganda number-word → digit normaliser, applied to Luganda transcripts BEFORE the
 * LLM sees them. Money and quantities must not depend on the model telling "bbiri" (2) from
 * "abiri" (20): in production a merchant's "dollar abiri" (20) was read as 2.
 *
 * Covers the forms merchants use for quantities and prices:
 *   units      emu 1 · bbiri 2 · ssatu 3 · nnya 4 · ttaano 5 · mukaaga 6 · musanvu 7 · munaana 8 · mwenda 9
 *   ten        kkumi 10, "kkumi na bbiri" 12
 *   tens       (amakumi) abiri 20 · asatu 30 · (amakumi) ana 40 · ataano 50 · nkaaga 60 · nsanvu 70 ·
 *              kinaana 80 · kyenda 90, "amakumi abiri mu ttaano" 25
 *   hundreds   kikumi 100 · bibiri 200 … · thousand lukumi 1000
 * The original transcript is always kept separately. Starter vocabulary — validate with native speakers.
 */
const UNITS: Record<string, number> = {
  emu: 1,
  omu: 1,
  bbiri: 2,
  ssatu: 3,
  nnya: 4,
  ttaano: 5,
  mukaaga: 6,
  musanvu: 7,
  munaana: 8,
  mwenda: 9,
};
/** Tens that are unambiguous on their own (no "amakumi" needed). */
const TENS: Record<string, number> = {
  kkumi: 10,
  abiri: 20,
  asatu: 30,
  ataano: 50,
  nkaaga: 60,
  nsanvu: 70,
  kinaana: 80,
  kyenda: 90,
};
/** Tens that are only numbers after "amakumi" ("ana" is otherwise a common particle). */
const AMAKUMI_ONLY: Record<string, number> = { ana: 40 };
const HUNDREDS: Record<string, number> = {
  kikumi: 100,
  bibiri: 200,
  bisatu: 300,
  bina: 400,
  bitaano: 500,
  lukaaga: 600,
  lusanvu: 700,
  lunaana: 800,
  lwenda: 900,
};
const THOUSAND = 'lukumi';

const word = (w: string | undefined) => (w ?? '').toLowerCase().replace(/[^a-z']/g, '');

/** Parses a number phrase starting at tokens[i]; returns [value, tokensConsumed] or null. */
function parseAt(tokens: string[], i: number): [number, number] | null {
  let value = 0;
  let j = i;
  let matched = false;

  const take = (map: Record<string, number>) => {
    const v = map[word(tokens[j])];
    if (v === undefined) return undefined;
    j++;
    return v;
  };
  // optional "na"/"mu" joiner before the next component ("kkumi na bbiri", "amakumi abiri mu ttaano")
  const joinThen = (map: Record<string, number>) => {
    const joiner = word(tokens[j]);
    if (
      (joiner === 'na' || joiner === 'mu' || joiner === "n'") &&
      map[word(tokens[j + 1])] !== undefined
    ) {
      j++;
      return take(map);
    }
    return undefined;
  };

  if (word(tokens[j]) === THOUSAND) {
    value += 1000;
    j++;
    matched = true;
    const more = joinThen(HUNDREDS) ?? joinThen(TENS) ?? joinThen(UNITS);
    if (more !== undefined) value += more;
  }
  const h = take(HUNDREDS);
  if (h !== undefined) {
    value += h;
    matched = true;
  }
  let t: number | undefined;
  // "… mu amakumi ataano" (hundreds/thousands followed by joined tens)
  if (matched && ['mu', 'na'].includes(word(tokens[j])) && word(tokens[j + 1]) === 'amakumi') j++;
  if (word(tokens[j]) === 'amakumi') {
    const next = word(tokens[j + 1]);
    const v = TENS[next] ?? AMAKUMI_ONLY[next];
    if (v !== undefined) {
      j += 2;
      t = v;
    }
  } else if (!matched || word(tokens[j - 1]) === 'na' || word(tokens[j - 1]) === 'mu') {
    t = take(TENS);
  } else {
    t = joinThen(TENS);
  }
  if (t !== undefined) {
    value += t;
    matched = true;
    const u = joinThen(UNITS);
    if (u !== undefined) value += u;
  } else if (!matched) {
    const u = take(UNITS);
    if (u !== undefined) {
      value += u;
      matched = true;
    }
  }
  return matched ? [value, j - i] : null;
}

export function normalizeLugandaNumbers(text: string): string {
  const tokens = text.split(/(\s+)/); // keep whitespace tokens to preserve spacing
  const words: { token: string; index: number }[] = [];
  tokens.forEach((token, index) => {
    if (token.trim()) words.push({ token, index });
  });
  const plain = words.map((w) => w.token);
  const out: string[] = [];
  for (let i = 0; i < plain.length;) {
    const parsed = parseAt(plain, i);
    if (parsed) {
      const [value, used] = parsed;
      const trailing = plain[i + used - 1]!.match(/[.,!?;:]+$/)?.[0] ?? '';
      out.push(String(value) + trailing);
      i += used;
    } else {
      out.push(plain[i]!);
      i++;
    }
  }
  return out.join(' ');
}
