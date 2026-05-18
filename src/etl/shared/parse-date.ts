import { parse } from "date-fns";

const DATE_FMT = "dd/MM/yyyy";
const DATETIME_FMT = "dd/MM/yyyy HH:mm";

export function parseFfhbDate(input: string): Date | null {
  if (!input || input.trim().length === 0) return null;
  const d = parse(input.trim(), DATE_FMT, new Date(Date.UTC(2000, 0, 1)));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

export interface ParsedDateTime {
  value: Date;
  heure_estimee: boolean;
}

export function parseFfhbDateTime(input: string): ParsedDateTime | null {
  if (!input || input.trim().length === 0) return null;
  const trimmed = input.trim();
  const hasTime = /\d{2}:\d{2}/.test(trimmed);
  const fmt = hasTime ? DATETIME_FMT : DATE_FMT;
  const d = parse(trimmed, fmt, new Date(Date.UTC(2000, 0, 1)));
  if (Number.isNaN(d.getTime())) return null;
  const value = hasTime
    ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()))
    : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return { value, heure_estimee: !hasTime };
}
