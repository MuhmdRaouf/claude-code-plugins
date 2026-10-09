/** Separators that start a word: a match right after one scores as a word start. */
const WORD_START = /[\s.\-_/:]/;
const SUBSEQ_START = /[\s.\-_/]/;

/**
 * Score how well `query` matches `text`, higher is better, -1 when some word does not match. Every word of the
 * query must match: a substring scores best (earlier and at a word start is better), a subsequence scores by how
 * many of its characters run together. Longer texts lose a little, so the shorter of two equal matches wins.
 */
export function fuzzy(query: string, text: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const s = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    const at = s.indexOf(word);
    if (at >= 0) {
      total +=
        60 + word.length * 4 - Math.min(at, 30) + (at === 0 || WORD_START.test(s.charAt(at - 1)) ? 25 : 0);
      continue;
    }
    const score = subsequence(word, s);
    if (score < 0) return -1;
    total += score;
  }
  return total - s.length * 0.02;
}

function subsequence(word: string, s: string): number {
  let from = 0;
  let score = 0;
  let last = -2;
  for (const ch of word) {
    const j = s.indexOf(ch, from);
    if (j < 0) return -1;
    score += j === last + 1 ? 3 : 1;
    if (j === 0 || SUBSEQ_START.test(s.charAt(j - 1))) score += 2;
    last = j;
    from = j + 1;
  }
  return score;
}
