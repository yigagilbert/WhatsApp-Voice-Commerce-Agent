/**
 * Small, deterministic "did you mean" helper for names and products misheard by speech recognition
 * ("ssaala" → Sarah, "buckets" → Handmade Basket). Only ever used to SUGGEST — never to act.
 */
function simplify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/(.)\1+/g, '$1') // collapse doubled letters: ssaala → sala
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
    .join(' ');
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

/**
 * Candidates whose name — or any word of it — is within ~40% edit distance of the query.
 * Sorted best first. E.g. closestMatches('ssaala', ['Sarah Thompson']) → ['Sarah Thompson'].
 */
export function closestMatches(query: string, candidates: string[], limit = 3): string[] {
  const q = simplify(query);
  if (!q) return [];
  const scored = candidates
    .map((candidate) => {
      const c = simplify(candidate);
      const rel = (a: string, b: string) => distance(a, b) / Math.max(a.length, b.length);
      const parts = [c, ...c.split(' ')];
      const whole = Math.min(...parts.map((p) => rel(q, p)));
      // Word by word: each spoken word's best match among the candidate's words, averaged.
      const qWords = q.split(' ');
      const cWords = c.split(' ');
      const perWord =
        qWords.reduce((sum, w) => sum + Math.min(...cWords.map((cw) => rel(w, cw))), 0) /
        qWords.length;
      return { candidate, best: Math.min(whole, perWord) };
    })
    .filter((s) => s.best <= 0.4)
    .sort((a, b) => a.best - b.best);
  return scored.slice(0, limit).map((s) => s.candidate);
}
