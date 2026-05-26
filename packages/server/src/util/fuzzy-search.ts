/**
 * Fuzzy string search for patch_file operations.
 *
 * When an exact match for a search string is not found in a file, this module
 * attempts a fuzzy match: it slides a window of the same length as the search
 * string across the file content and finds the window position with the highest
 * similarity score. If that best score meets or exceeds FUZZY_THRESHOLD, the
 * match is accepted and the actual matched text is returned so the operation can
 * proceed with the correct on-disk content.
 *
 * Algorithm: normalised Levenshtein similarity
 *   similarity = 1 - (editDistance / maxLength)
 *
 * The threshold is intentionally strict (0.9 = 90%) to avoid accidentally
 * matching wrong content. A match requires 9 out of every 10 characters to
 * align.
 */

export const FUZZY_THRESHOLD = 0.9;

export interface FuzzyMatch {
  /** The actual substring from the file that was matched. */
  matchedText: string;
  /** 0–1 similarity score (1 = exact). */
  similarity: number;
  /** Character offset in the file where the match starts. */
  position: number;
}

export interface FuzzyMatchInfo {
  /** 0-based index of the edit within the edits array. */
  editIndex: number;
  /** The search string the AI originally provided. */
  searchedFor: string;
  /** The actual text in the file that was matched. */
  matchedTo: string;
  /** Similarity score (0–1). */
  similarity: number;
}

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses the standard DP approach with two rolling rows for memory efficiency.
 * Bails out early if the minimum possible distance already exceeds `maxDist`.
 */
function levenshteinDistance(a: string, b: string, maxDist: number): number {
  // Work on the shorter string as `a` for the inner loop
  if (a.length > b.length) { const t = a; a = b; b = t; }

  const aLen = a.length;
  const bLen = b.length;

  // Fast path — length difference alone exceeds threshold
  if (bLen - aLen > maxDist) return maxDist + 1;

  let prev = new Uint32Array(aLen + 1);
  let curr = new Uint32Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) prev[i] = i;

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    let rowMin = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
      if (curr[i] < rowMin) rowMin = curr[i];
    }
    // Early exit: if entire row is above maxDist, no path will recover
    if (rowMin > maxDist) return maxDist + 1;
    // Swap buffers
    const tmp = prev; prev = curr; curr = tmp;
  }

  return prev[aLen];
}

/**
 * Compute normalised similarity between two strings (0–1).
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const maxDist = Math.ceil(maxLen * (1 - FUZZY_THRESHOLD));
  const dist = levenshteinDistance(a, b, maxDist);
  return 1 - dist / maxLen;
}

/**
 * Attempt a fuzzy match of `search` against `fileContent`.
 *
 * Returns the best FuzzyMatch if its similarity >= FUZZY_THRESHOLD AND the
 * match is unique (no second window scores >= FUZZY_THRESHOLD), otherwise null.
 *
 * Uniqueness is required for the same reason exact matching requires it: we
 * must know unambiguously which part of the file to edit.
 */
export function fuzzyFind(search: string, fileContent: string): FuzzyMatch | null {
  const searchLen = search.length;
  const contentLen = fileContent.length;

  if (searchLen === 0 || contentLen === 0) return null;
  if (searchLen > contentLen) return null;

  // Cap the edit distance budget for the early-bail in levenshtein
  const maxAllowedDist = Math.ceil(searchLen * (1 - FUZZY_THRESHOLD));

  let bestScore = -1;
  let bestPos = -1;
  let bestText = '';
  let secondBestScore = -1;

  // Slide a window of exactly `searchLen` characters across the file.
  // Step by 1 character for full coverage.
  for (let i = 0; i <= contentLen - searchLen; i++) {
    const window = fileContent.slice(i, i + searchLen);
    const score = similarity(search, window);

    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestPos = i;
      bestText = window;
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  // Must meet threshold
  if (bestScore < FUZZY_THRESHOLD) return null;

  // Must be unique: no other window at or above threshold
  // (secondBestScore < FUZZY_THRESHOLD means only one window qualified)
  if (secondBestScore >= FUZZY_THRESHOLD) return null;

  return { matchedText: bestText, similarity: bestScore, position: bestPos };
}
