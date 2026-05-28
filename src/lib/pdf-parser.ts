import { createRequire } from "node:module";
import { logger } from "@/lib/logger.js";

const require = createRequire(import.meta.url);

// pdf-parse v2 expose une classe PDFParse
interface PDFParseClass {
  new (options: { data: Buffer }): {
    getText(): Promise<{ pages: Array<{ text: string; num: number }> }>;
  };
}
const { PDFParse } = require("pdf-parse") as { PDFParse: PDFParseClass };

export interface ExtractedPdf {
  numPages: number;
  pages: string[]; // texte par page, indexé depuis 0
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdf | null> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return {
      numPages: result.pages.length,
      pages: result.pages.map((p) => p.text),
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "pdf-parse extraction failed");
    return null;
  }
}
