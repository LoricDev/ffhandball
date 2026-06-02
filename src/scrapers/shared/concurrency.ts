// src/scrapers/shared/concurrency.ts
// Pool de workers : traite `items` avec au plus `concurrency` tâches en vol simultanément.
// Chaque worker tire l'élément suivant dès qu'il est libre (pas de barrière par lot).
// Fail-fast : si un worker lève, Promise.all rejette et l'erreur remonte (comme la boucle
// séquentielle d'origine) ; les autres tâches déjà en vol se terminent mais sont ignorées.

export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  if (n === 0) return;

  let next = 0;
  async function runner(): Promise<void> {
    for (;;) {
      const i = next++; // incrément synchrone → pas de course entre workers
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: n }, () => runner()));
}
