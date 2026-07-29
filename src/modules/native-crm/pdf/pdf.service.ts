import puppeteer from 'puppeteer';

export interface PdfOptions {
  marginTopPx?:    number;
  marginBottomPx?: number;
}

export async function generatePdfFromHtml(html: string, opts?: PdfOptions): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // Wait for remote images (logo/signature/QR via storage URLs) to settle
    // before capture; capped so one slow URL can't hang generation. A timeout
    // just means the PDF may miss that image — better than a 500.
    // (string form because the backend tsconfig has no DOM lib)
    await page.evaluate(`Promise.race([
      Promise.all(Array.from(document.images).filter(i => !i.complete).map(i => new Promise(r => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
      }))),
      new Promise(r => setTimeout(r, 10000)),
    ])`).catch(() => {});
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top:    `${opts?.marginTopPx ?? 0}px`,
        right:  '0',
        bottom: `${opts?.marginBottomPx ?? 0}px`,
        left:   '0',
      },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
