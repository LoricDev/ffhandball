import { describe, it, expect } from "vitest";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";

describe("canonicalizeSaison", () => {
  it("accepts already canonical", () => {
    expect(canonicalizeSaison("2025-2026")).toBe("2025-2026");
  });

  it("accepts slash separator", () => {
    expect(canonicalizeSaison("2025/2026")).toBe("2025-2026");
  });

  it("accepts short form", () => {
    expect(canonicalizeSaison("25-26")).toBe("2025-2026");
  });

  it("rejects non-consecutive years", () => {
    expect(() => canonicalizeSaison("2025-2027")).toThrow();
  });

  it("rejects garbage", () => {
    expect(() => canonicalizeSaison("foo")).toThrow();
  });
});
