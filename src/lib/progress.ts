// src/lib/progress.ts — indicateur de progression léger pour scrapes/ETL.
// Écrit sur stderr (le logger pino est sur stdout → pas de mélange). En terminal (TTY) :
// une ligne mise à jour en live (\r + %/débit/ETA). Hors TTY (cron, pipe) : une ligne tous
// les ~5 % ou 30 s, pour un log lisible sans spam. Désactivable via PROGRESS=0.

const ENABLED = process.env.PROGRESS !== "0";
const IS_TTY = process.stderr.isTTY === true;

function group(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

export class Progress {
  private readonly start: number;
  private lastEmit = 0;
  private lastPct = -100;

  constructor(
    private readonly label: string,
    private readonly total: number | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.start = this.now();
  }

  /** À appeler avec le nombre d'éléments traités jusqu'ici. */
  tick(current: number): void {
    if (!ENABLED) return;
    const t = this.now();
    if (IS_TTY) {
      if (t - this.lastEmit < 200) return; // ~5 rafraîchissements/s
      this.lastEmit = t;
      process.stderr.write(`\r${this.render(current, t)}\x1b[K`);
    } else {
      const pct = this.total ? Math.floor((current / this.total) * 100) : -1;
      const stepHit = this.total !== null && pct >= this.lastPct + 5;
      const timeHit = t - this.lastEmit > 30_000;
      if (stepHit || timeHit) {
        if (this.total !== null) this.lastPct = pct;
        this.lastEmit = t;
        process.stderr.write(`${this.render(current, t)}\n`);
      }
    }
  }

  /** Ligne finale (efface la barre live en TTY). */
  done(current?: number): void {
    if (!ENABLED) return;
    const t = this.now();
    const final = current ?? this.total ?? 0;
    const line = this.render(final, t, true);
    process.stderr.write(IS_TTY ? `\r${line}\x1b[K\n` : `${line}\n`);
  }

  private render(current: number, t: number, final = false): string {
    const elapsed = (t - this.start) / 1000;
    const rate = elapsed > 0 ? current / elapsed : 0;
    const parts = [`${this.label}:`];
    parts.push(this.total !== null ? `${group(current)}/${group(this.total)}` : group(current));
    if (this.total) parts.push(`${Math.floor((current / this.total) * 100)}%`);
    parts.push(`${rate.toFixed(rate < 10 ? 1 : 0)}/s`);
    parts.push(fmtDuration(elapsed));
    if (!final && this.total && rate > 0 && current < this.total) {
      parts.push(`ETA ${fmtDuration((this.total - current) / rate)}`);
    }
    if (final) parts.push("✓");
    return `  ${parts.join("  ")}`;
  }
}
