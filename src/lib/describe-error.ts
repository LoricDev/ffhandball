// src/lib/describe-error.ts — message d'erreur lisible, en particulier pour les erreurs de
// connexion Postgres (pg lève une AggregateError au message vide quand aucun host n'est joignable).
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const codes = err.errors.map((e) => (e as { code?: string }).code).filter(Boolean);
    const msgs = err.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    const detail = msgs.find(Boolean) ?? "connexion impossible";
    if (codes.includes("ECONNREFUSED")) {
      return `base de données injoignable (${detail}). Vérifiez que Postgres tourne et DATABASE_URL.`;
    }
    return detail;
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === "ECONNREFUSED") {
      return `base de données injoignable (${err.message}). Vérifiez que Postgres tourne et DATABASE_URL.`;
    }
    return err.message || code || String(err);
  }
  return String(err);
}
