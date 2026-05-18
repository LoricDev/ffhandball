import { describe, it, expect } from "vitest";
import { parseFfhbDate, parseFfhbDateTime } from "@/etl/shared/parse-date.js";

describe("parseFfhbDate", () => {
  it("parses DD/MM/YYYY", () => {
    const d = parseFfhbDate("15/03/2026");
    expect(d!.toISOString().slice(0, 10)).toBe("2026-03-15");
  });

  it("returns null for invalid", () => {
    expect(parseFfhbDate("not a date")).toBeNull();
  });

  it("returns null for empty", () => {
    expect(parseFfhbDate("")).toBeNull();
  });
});

describe("parseFfhbDateTime", () => {
  it("parses DD/MM/YYYY HH:mm as UTC", () => {
    const d = parseFfhbDateTime("15/03/2026 18:30");
    expect(d!.value.toISOString()).toBe("2026-03-15T18:30:00.000Z");
    expect(d!.heure_estimee).toBe(false);
  });

  it("flags estimated when only date provided", () => {
    const d = parseFfhbDateTime("15/03/2026");
    expect(d!.value.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(d!.heure_estimee).toBe(true);
  });

  it("returns null on garbage", () => {
    expect(parseFfhbDateTime("xx/yy/zzzz")).toBeNull();
  });
});
