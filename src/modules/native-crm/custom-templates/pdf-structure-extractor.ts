/**
 * Extracts ground-truth text-run positions from a real digital PDF (one
 * with an embedded text layer — not a scan/photo). This is the fix for the
 * accuracy ceiling of pure vision-based analysis: a genuine digital PDF
 * already contains every text run's exact x/y position, font, and size as
 * real data inside the file — reading it directly is strictly more
 * accurate than asking an AI to visually reconstruct it from a picture.
 *
 * Scope, stated honestly: only text-run positions are extracted precisely.
 * Image placement (logo/signature/etc.) would require walking the PDF's
 * full graphics-state stack (tracking save/restore/transform ops to know
 * the CTM at each paintImageXObject call) — real work pdf.js's own
 * renderer does internally but doesn't expose as a simple position API.
 * Since the actual reported accuracy problem was text (duplicate/missing
 * text sections), this only counts image presence, not position — the AI
 * still uses reasonable placement conventions for those, same as it
 * already does when no structured data is available at all.
 */

const CANVAS_W = 794; // matches frontend TemplateDesignerPage.tsx CANVAS_W (A4 @ 96dpi)
const MIN_TEXT_LENGTH = 50; // below this, treat as scanned/no text layer — fall back to vision

export interface PdfTextRun {
  text:     string;
  x:        number;
  y:        number;
  fontSize: number;
  fontName: string;
}

export interface PdfStructure {
  textRuns:   PdfTextRun[];
  imageCount: number;
}

/**
 * Returns extracted structure for page 1, or null if the PDF has no
 * meaningful embedded text layer (scanned/photographed page) or fails to
 * parse — either way, the caller falls back to the existing vision path.
 */
export async function extractPdfStructure(buffer: Buffer): Promise<PdfStructure | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const page = await doc.getPage(1);

    const [x0, y0, x1, y1] = page.view; // page bounds in PDF points
    const pageWidthPt  = x1 - x0;
    const pageHeightPt = y1 - y0;
    const scale = CANVAS_W / pageWidthPt;

    const textContent = await page.getTextContent();
    const textRuns: PdfTextRun[] = [];
    let totalChars = 0;

    for (const item of textContent.items as any[]) {
      const str: string | undefined = item.str;
      if (!str || !str.trim()) continue;
      totalChars += str.trim().length;
      // transform = [scaleX, skewX, skewY, scaleY, x, y] in PDF point-space,
      // y measured from the page BOTTOM — flip to canvas's top-down y.
      textRuns.push({
        text:     str,
        x:        Math.round(item.transform[4] * scale),
        y:        Math.round((pageHeightPt - item.transform[5]) * scale),
        fontSize: Math.max(6, Math.round(item.transform[0] * scale)),
        fontName: typeof item.fontName === 'string' ? item.fontName : '',
      });
    }

    if (totalChars < MIN_TEXT_LENGTH) return null;
    // Defensive cap for a pathologically text-dense page — keeps the
    // downstream prompt bounded regardless of source complexity.
    if (textRuns.length > 500) textRuns.length = 500;

    let imageCount = 0;
    const opList = await page.getOperatorList();
    const IMAGE_OPS = new Set([
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintInlineImageXObject,
      pdfjs.OPS.paintImageXObjectRepeat,
    ]);
    for (const fn of opList.fnArray) {
      if (IMAGE_OPS.has(fn)) imageCount++;
    }

    return { textRuns, imageCount };
  } catch {
    // Any extraction failure (corrupt/unusual encoding) — graceful
    // fallback, never a hard error for the caller.
    return null;
  }
}
