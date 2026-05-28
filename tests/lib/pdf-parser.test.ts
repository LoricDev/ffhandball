import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractPdfText } from "@/lib/pdf-parser.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

describe("extractPdfText", () => {
  it("extracts text from a 2-page FdM PDF", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const result = await extractPdfText(buf);
    expect(result.numPages).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toContain("Code Renc VAGPOQJ");
    expect(result.pages[1]).toContain("Déroulé du Match");
  });

  it("returns null on invalid PDF buffer", async () => {
    const result = await extractPdfText(Buffer.from("not a pdf"));
    expect(result).toBeNull();
  });
});
