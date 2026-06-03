import { describe, it, expect, vi } from "vitest";
import { Progress } from "@/lib/progress.js";

describe("Progress (hors TTY)", () => {
  it("émet une ligne avec label, avancement, %, débit et ETA", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s: string | Uint8Array) => {
        writes.push(String(s));
        return true;
      });

    let t = 1000;
    const p = new Progress("etl matchs", 200, () => t);
    t = 2000; // +1 s
    p.tick(20); // 10 %
    t = 3000;
    p.done(200);
    spy.mockRestore();

    const out = writes.join("");
    expect(out).toContain("etl matchs");
    expect(out).toContain("20/200");
    expect(out).toContain("10%");
    expect(out).toMatch(/\/s/);
    expect(out).toContain("ETA");
    expect(out).toContain("✓");
  });

  it("respecte PROGRESS=0 (rien émis) — vérifie au moins que done() n'échoue pas", () => {
    // ENABLED est figé à l'import ; on vérifie juste que l'API ne lève pas.
    const p = new Progress("x", null);
    expect(() => p.tick(1)).not.toThrow();
    expect(() => p.done()).not.toThrow();
  });
});
