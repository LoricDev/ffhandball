import { ValidationError } from "@/lib/errors.js";

const LONG_RE = /^(\d{4})[-\/](\d{4})$/;
const SHORT_RE = /^(\d{2})[-\/](\d{2})$/;

export function canonicalizeSaison(input: string): string {
  const trimmed = input.trim();
  const longMatch = LONG_RE.exec(trimmed);
  if (longMatch) {
    const a = Number(longMatch[1]);
    const b = Number(longMatch[2]);
    if (b !== a + 1) {
      throw new ValidationError(`Saison non consécutive: ${trimmed}`);
    }
    return `${a}-${b}`;
  }

  const shortMatch = SHORT_RE.exec(trimmed);
  if (shortMatch) {
    const a = 2000 + Number(shortMatch[1]);
    const b = 2000 + Number(shortMatch[2]);
    if (b !== a + 1) {
      throw new ValidationError(`Saison non consécutive: ${trimmed}`);
    }
    return `${a}-${b}`;
  }

  throw new ValidationError(`Format saison non reconnu: ${trimmed}`);
}
