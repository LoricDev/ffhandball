import { describe, it, expect } from "vitest";
import { forEachConcurrent } from "@/scrapers/shared/concurrency.js";

function deferredDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("forEachConcurrent", () => {
  it("traite tous les éléments, une seule fois chacun", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    await forEachConcurrent(items, 4, async (n) => {
      await deferredDelay(1);
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("ne dépasse jamais le plafond de concurrence", async () => {
    let active = 0;
    let maxActive = 0;
    await forEachConcurrent(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await deferredDelay(2);
      active--;
    });
    expect(maxActive).toBe(4);
  });

  it("plafonne au nombre d'éléments si concurrence > taille", async () => {
    let active = 0;
    let maxActive = 0;
    await forEachConcurrent([1, 2], 8, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await deferredDelay(2);
      active--;
    });
    expect(maxActive).toBe(2);
  });

  it("passe l'index correct au worker", async () => {
    const pairs: Array<[unknown, number]> = [];
    await forEachConcurrent(["a", "b", "c"], 1, async (item, i) => {
      pairs.push([item, i]);
    });
    expect(pairs).toEqual([["a", 0], ["b", 1], ["c", 2]]);
  });

  it("fail-fast : propage l'erreur d'un worker", async () => {
    await expect(
      forEachConcurrent([1, 2, 3, 4], 2, async (n) => {
        if (n === 3) throw new Error("boom");
        await deferredDelay(1);
      }),
    ).rejects.toThrow("boom");
  });

  it("liste vide : ne fait rien", async () => {
    let calls = 0;
    await forEachConcurrent([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
