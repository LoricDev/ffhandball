const INVISIBLE_RE = /[​‌‍‎‏﻿]/g;
const WHITESPACE_RE = /\s+/g;
const PARTICLES = new Set(["de", "du", "des", "la", "le", "les", "et"]);

export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

function capFirst(word: string): string {
  if (word.length === 0) return word;
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

function capitalizeToken(token: string, isFirst: boolean): string {
  const apos = token.indexOf("'");
  if (apos > 0 && apos < token.length - 1) {
    const left = token.slice(0, apos).toLowerCase();
    const right = token.slice(apos + 1);
    if (left.length <= 2) {
      return `${left}'${capFirst(right)}`;
    }
  }

  if (token.includes("-")) {
    return token
      .split("-")
      .map((seg) => capFirst(seg))
      .join("-");
  }

  const lower = token.toLowerCase();
  if (!isFirst && PARTICLES.has(lower)) return lower;
  return capFirst(token);
}

export function titleCaseFr(input: string): string {
  const cleaned = normalizeText(input);
  return cleaned
    .split(" ")
    .map((token, i) => capitalizeToken(token, i === 0))
    .join(" ");
}
