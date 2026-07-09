const ARABIC_YEH = /[يى]/g;
const ARABIC_KAF = /ك/g;
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670]/g;
const ZERO_WIDTH = /[\u200B-\u200F\uFEFF]/g;

const MIN_PREFIX_LEN = 2;
const MAX_PREFIX_LEN = 15;

export function normalizeText(input: string): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .replace(ZERO_WIDTH, "")
    .replace(ARABIC_YEH, "ی")
    .replace(ARABIC_KAF, "ک")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

export function wordPrefixes(word: string): string[] {
  const capped = word.slice(0, MAX_PREFIX_LEN);
  const prefixes: string[] = [];
  for (let i = MIN_PREFIX_LEN; i <= capped.length; i++) {
    prefixes.push(capped.slice(0, i));
  }
  return prefixes;
}

export interface SearchFields {
  searchWords: string[];
  searchPrefixes: string[];
}

export function buildSearchFields(
  ...texts: (string | undefined | null)[]
): SearchFields {
  const words = new Set<string>();
  const prefixes = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const word of tokenize(text)) {
      words.add(word);
      for (const p of wordPrefixes(word)) prefixes.add(p);
    }
  }

  return {
    searchWords: Array.from(words),
    searchPrefixes: Array.from(prefixes),
  };
}

export interface SearchQueryParts {
  clauses: Record<string, any>[];
}

export function buildSearchQuery(raw: string): SearchQueryParts {
  const words = tokenize(raw);
  if (words.length === 0) return { clauses: [] };

  const lastWord = words[words.length - 1];
  const fullWords = words.slice(0, -1);

  const clauses: Record<string, any>[] = fullWords.map((w) => ({
    searchWords: w,
  }));

  if (lastWord.length >= MIN_PREFIX_LEN) {
    clauses.push({ searchPrefixes: lastWord });
  } else {
    clauses.push({ searchWords: lastWord });
  }

  return { clauses };
}