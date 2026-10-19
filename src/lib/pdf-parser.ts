import { createRequire } from "node:module";
import { logger } from "@/lib/logger.js";

const require = createRequire(import.meta.url);

// pdf-parse v2 expose une classe PDFParse
interface PDFParseClass {
  new (options: { data: Buffer }): {
    getText(): Promise<{ pages: Array<{ text: string; num: number }> }>;
    load(): Promise<{
      getPage(n: number): Promise<{
        getTextContent(): Promise<{
          items: Array<{ str?: string; width?: number; transform?: number[] }>;
        }>;
      }>;
    }>;
  };
}
const { PDFParse } = require("pdf-parse") as { PDFParse: PDFParseClass };

/** Fragment de texte avec sa position (repère PDF : y croît vers le haut). */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

export interface ExtractedPdf {
  numPages: number;
  pages: string[]; // texte par page, indexé depuis 0
  /** Fragments positionnés de la page 1 (vide si indisponible) — permet de retrouver les colonnes d'un tableau. */
  page1Items: PdfTextItem[];
}

async function extractPage1Items(parser: InstanceType<typeof PDFParse>): Promise<PdfTextItem[]> {
  try {
    const doc = await parser.load();
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const i of content.items) {
      const str = i.str?.trim();
      if (!str || !i.transform) continue;
      items.push({ str, x: i.transform[4] ?? 0, y: i.transform[5] ?? 0, width: i.width ?? 0 });
    }
    return items;
  } catch (err) {
    logger.warn({ err: String(err) }, "pdf-parse: extraction des positions échouée");
    return [];
  }
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdf | null> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return {
      numPages: result.pages.length,
      pages: result.pages.map((p) => p.text),
      page1Items: await extractPage1Items(parser),
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "pdf-parse extraction failed");
    return null;
  }
}
