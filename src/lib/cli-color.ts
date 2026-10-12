// src/lib/cli-color.ts — coloration ANSI partagée par les CLIs (doctor, migrate, prune-raw).
// Activée seulement en TTY (désactivée si pipe/redirection ou NO_COLOR), ou forçable.
let enabled = false;

export function initColor(force?: boolean): void {
  enabled = force ?? (process.env.NO_COLOR == null && Boolean(process.stdout.isTTY));
}

const p = (code: string, s: string): string => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const col = {
  bold: (s: string) => p("1", s),
  dim: (s: string) => p("2", s),
  red: (s: string) => p("31", s),
  green: (s: string) => p("32", s),
  yellow: (s: string) => p("33", s),
  cyan: (s: string) => p("36", s),
  gray: (s: string) => p("90", s),
};
