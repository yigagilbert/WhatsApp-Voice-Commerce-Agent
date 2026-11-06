/**
 * Deterministic reading of customer words. Everything here is deliberately narrow: a rule only
 * fires when it is confident, and everything else goes to the assistant, which can ask.
 */

/** Lowercase, without emoji and punctuation, so "Hi 👋!!" and "hi" read the same. */
export const normalizeWords = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const GREETING_WORD =
  '(?:hi+|hello+|hey+|hallo|hola|yo|greetings|howdy|oli otya|good (?:morning|afternoon|evening|day)|morning|afternoon|evening)';
const FILLER =
  "(?:there|again|all|everyone|team|sir|madam|maam|ma'am|boss|friend|dear|katale|shop|bro|sis|please|pls|mam)";
const GREETING_PATTERN = new RegExp(`^${GREETING_WORD}(?: ${GREETING_WORD})*(?: ${FILLER})*$`);

/** "hi there", "Hi 👋", "good morning sir": a greeting and nothing else. */
export const isGreeting = (text: string): boolean => {
  const words = normalizeWords(text);
  return !!words && GREETING_PATTERN.test(words);
};

/** A bare wave with no words: the customer is saying hello. */
export const isWave = (text: string): boolean =>
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(text) &&
  /👋|🙏|🤝|😀|😃|😊|🙂/u.test(text);

/** Show-me-the-menu words, which never greet the customer again. */
export const isMenuRequest = (text: string): boolean =>
  /^(start|menu|main menu|help|options|0)$/.test(normalizeWords(text));

/** Polite closers that need a short reply, not the assistant. */
export const isCloser = (text: string): boolean =>
  /^(thanks?|thank you( so much| very much)?|thx|ty|asante|webale|okay thanks?|ok thanks?|ok thank you|bye|goodbye|good night|see you|cheers)( bye| goodbye)?$/.test(
    normalizeWords(text),
  );

/** Explicit requests for a person. "a gift for my manager" and "someone told me" aren't. */
const HANDOFF_PATTERNS = [
  /^(a |the |real |human |live )*(person|human|agent|staff|owner|manager|seller|someone|somebody|team)( please| pls)?$/,
  /\b(talk|speak|chat)( to| with)( a| an| the| your| some| real| human| live)* (person|human|agent|staff|owner|manager|seller|someone|somebody|team|shop|representative|rep)\b/,
  /\b(get|connect|put|transfer) me( to| with| through to)?( a| an| the| your| real| human| live)* (person|human|agent|staff|owner|manager|seller|someone|somebody|representative|rep)( please| pls)?$/,
  /\b(need|want|like|looking for)( to talk to| to speak to| to speak with| to talk with)?( a| an| to| the| your)* (real|human|live) (person|human|agent|someone)\b/,
  /\b(i|we) (need|want)( to talk to| to speak to| to speak with| to talk with)( a| an| the| your)* (person|human|agent|staff|owner|manager|seller|someone|somebody)\b/,
  /\b(is there|can i get|can i have|may i have|may i speak to|can i speak to|can i talk to)( a| an| the| your| someone| somebody| real)* ?(person|human|agent|staff|owner|manager|someone|somebody)?( i can talk to| to talk to| to speak to| there)?$/,
  /\b(call|phone) me( back)?$/,
];

/** The customer clearly wants a person. Ambiguous wording is left to the assistant. */
export const wantsPerson = (text: string): boolean => {
  const words = normalizeWords(text);
  if (!words) return false;
  // "can i get ..." with nothing about a person was never a request for one.
  if (/^(is there|can i get|can i have|may i have)( a| an| the| your)?$/.test(words)) return false;
  return HANDOFF_PATTERNS.some((p) => p.test(words));
};

/** During a hand-off: the customer wants the automated assistant back. */
export const wantsBot = (text: string): boolean =>
  /^(bot|back|menu|main menu|assistant|shop|browse|resume|continue|start|go back|back to (the )?(bot|menu|assistant|shop)|talk to (the )?(bot|assistant)|use (the )?(bot|assistant))( please| pls)?$/.test(
    normalizeWords(text),
  );

/** Words that begin a sentence, a question or an instruction, but never an address. */
const NOT_ADDRESS_START =
  /^(wait|hold on|hold|hang on|sorry|actually|no|nope|not|yes|yeah|yep|ok|okay|sure|please|pls|plz|thanks|thank|hi|hello|hey|add|remove|delete|change|cancel|stop|back|undo|make it|make|one more|another|also|i|i'm|im|i'll|we|we'll|my name|can|could|would|will|shall|should|do|does|did|is|are|am|was|what|when|where|which|who|why|how|how much|show|see|tell|give|send|let|let's|lets|need|want|maybe|hmm|um|uh|never ?mind|forget|how about|but|and|so|because|just|the price|price|discount)\b/;
/** Words that make text read like a place. */
const ADDRESS_SIGNAL =
  /\b(plot|street|st|road|rd|avenue|ave|lane|ln|close|drive|dr|estate|village|zone|ward|parish|district|apartment|apt|flat|house|building|block|floor|suite|shop|stage|near|opposite|behind|next to|beside|po box|box|kampala|entebbe|jinja|gulu|mbarara|wakiso|mukono|ntinda|kololo|nakasero|bukoto|kira|najjera|kansanga|muyenga|makindye|nansana|bweyogerere|naalya|lugogo)\b/;

export type AddressReading =
  { kind: 'address' } | { kind: 'not_address'; reason: 'short' | 'chat' };

/**
 * Is this text a delivery address? A short sentence like "wait add another one" must never become
 * one. Without a place word it must look like a name of a place (no conversational opening).
 */
export function readAddress(text: string): AddressReading {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = normalizeWords(clean);
  if (clean.length < 8 || clean.length > 300 || words.split(' ').length < 2)
    return { kind: 'not_address', reason: 'short' };
  const signal = ADDRESS_SIGNAL.test(words) || /\d/.test(words);
  if (/\?\s*$/.test(clean)) return { kind: 'not_address', reason: 'chat' };
  if (NOT_ADDRESS_START.test(words)) {
    // "No. 5 Acacia Avenue" and "Block 3" are addresses that happen to start oddly.
    if (/^no\.?\s*\d/i.test(clean)) return { kind: 'address' };
    return { kind: 'not_address', reason: 'chat' };
  }
  if (signal) return { kind: 'address' };
  // Two or more plain words with no signal ("Bugolobi Village Mall" has one; "Acacia Mall Gate")
  // are accepted: the customer sees them in the summary and must still reply ORDER.
  return words.split(' ').length >= 2
    ? { kind: 'address' }
    : { kind: 'not_address', reason: 'chat' };
}

/** Text that reads as a place on its own, so it can correct an address without being asked for. */
export const isClearlyAddress = (text: string): boolean =>
  readAddress(text).kind === 'address' &&
  ADDRESS_SIGNAL.test(normalizeWords(text)) &&
  !/\b(baskets?|wallets?|cart|price|discount)\b/.test(normalizeWords(text));

/** A name, not a sentence: "wait add another one" or "how much is it" aren't anyone's name. */
export const readName = (text: string): boolean => {
  const words = normalizeWords(text);
  const count = words.split(' ').length;
  return (
    text.trim().length >= 2 &&
    count <= 5 &&
    !/\?\s*$/.test(text) &&
    !/\d{4,}/.test(text) &&
    !NOT_ADDRESS_START.test(words)
  );
};

/** "change address", "wrong address": the customer wants to correct the delivery address. */
export const wantsAddressChange = (text: string): boolean =>
  /^(please )?((change|update|edit|fix|correct)( my| the)?( delivery)? (address|location)|wrong address|new address|different address)( please| pls)?$/.test(
    normalizeWords(text),
  );

/** "change address to X", "deliver to X", "my address is X": the new address itself. */
export const newAddressIn = (text: string): string | null => {
  const match =
    /^(?:please\s+)?(?:(?:change|update|set)\s+(?:my\s+|the\s+)?(?:delivery\s+)?address\s+to|(?:please\s+)?deliver(?:\s+it)?\s+to|send(?:\s+it)?\s+to|my\s+(?:new\s+|delivery\s+)?address\s+is|the\s+address\s+is|new\s+address[:\s]+)\s*:?\s*(.{8,300})$/i.exec(
      text.trim(),
    );
  return match ? match[1]!.trim() : null;
};

/** "pick up instead", "I'll collect it", "deliver instead": switching how they get the order. */
export const wantsMethod = (text: string): 'DELIVERY' | 'PICKUP' | null => {
  const words = normalizeWords(text);
  if (
    /\b(pick ?up|collect)\b.*\b(instead|myself|it|please)?$/.test(words) &&
    words.split(' ').length <= 6
  )
    return 'PICKUP';
  if (/^(deliver|delivery)( it)?( instead| please)?$|\bdeliver(y)? instead\b/.test(words))
    return 'DELIVERY';
  return null;
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** "add another one", "one more", "add two more": more of the product under discussion. */
export const moreOfThis = (text: string): number | null => {
  const match =
    /^(?:wait |actually |sorry |ok |okay |please )*(?:add )?(?:another|(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten) more)(?: one| of (?:it|this|that|these|those))?(?: please| pls)?$/.exec(
      normalizeWords(text),
    );
  if (!match) return null;
  if (!match[1]) return 1;
  return WORD_NUMBERS[match[1]] ?? Number(match[1]);
};

/** "make it three", "change it to 2", "actually two": a new quantity for what's being discussed. */
export const newQuantity = (text: string): number | null => {
  const match =
    /^(?:wait |actually |sorry |ok |okay |please |no )*(?:make (?:it|that)|change (?:it|that) to|i want|i'll take|just|only)? ?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?: instead| please| pls| of (?:them|these|those|it))?$/.exec(
      normalizeWords(text),
    );
  // A bare number means a list choice; only a phrase with intent words is a quantity.
  if (!match || /^\d{1,2}$/.test(normalizeWords(text))) return null;
  return WORD_NUMBERS[match[1]!] ?? Number(match[1]);
};

/** "how much is this?", "what's the price": asking the price of what they point at. */
export const asksPrice = (text: string): boolean =>
  /\b(how much|price|cost|what do(es)? (it|this|that) cost|how many shillings)\b/.test(
    normalizeWords(text),
  );

/** Words that accept an offer when the customer is pointing at it. */
export const acceptsOffer = (text: string): boolean =>
  /^(ok|okay|yes|yes please|i'll take (it|this|that)|ill take (it|this|that)|i will take (it|this|that)|i take (it|this|that)|take (it|this)|deal|sure|agreed)$/.test(
    normalizeWords(text),
  );

/** Whisper's well-known inventions on silence and noise, never treated as speech. */
const HALLUCINATIONS = [
  'thank you for watching',
  'thanks for watching',
  'thank you',
  'you',
  'bye',
  'bye bye',
  'subscribe',
  'please subscribe',
  'like and subscribe',
  'subtitles by the amara org community',
  'music',
  'silence',
];

/** A transcript that is one of those phrases, or has no words at all. */
export const isLikelyHallucination = (transcript: string): boolean => {
  const words = normalizeWords(transcript);
  return !words || HALLUCINATIONS.includes(words);
};
