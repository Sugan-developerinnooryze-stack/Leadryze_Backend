import fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer';
import { IDesignElement, ITemplatePage, ITemplateRegion } from '../custom-templates/custom-template.model';
import { RenderCtx } from './variable-catalog';
import { renderCustomTemplateFull, RenderedTemplate, FLOW_TYPES } from './pdf.variable-renderer';

export interface PdfOptions {
  marginTopPx?:    number;
  marginBottomPx?: number;
}

function resolveBrowserExecutable(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidatePaths = [
    process.env['PROGRAMFILES'] && `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['LOCALAPPDATA'] && `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    process.env['PROGRAMFILES'] && `${process.env['PROGRAMFILES']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean) as string[];

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore path access error
    }
  }

  return undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  const execPath = resolveBrowserExecutable();
  const launchOpts: any = {
    headless: true,
    args: baseArgs,
  };
  if (execPath) {
    launchOpts.executablePath = execPath;
  }

  try {
    return await puppeteer.launch(launchOpts);
  } catch (err: any) {
    if (launchOpts.executablePath) {
      try {
        delete launchOpts.executablePath;
        return await puppeteer.launch(launchOpts);
      } catch (fallbackErr: any) {
        throw new Error(`Failed to launch browser for PDF generation: ${fallbackErr.message || err.message}`);
      }
    }
    throw new Error(`Failed to launch browser for PDF generation: ${err.message}`);
  }
}

// Wait for remote images (logo/signature/QR/richtext images via storage URLs) to
// settle before measuring or capturing; capped so one slow URL can't hang
// generation. A timeout just means that image may be missed — better than a
// 500. String form because the backend tsconfig has no DOM lib.
async function waitForImages(page: Page): Promise<void> {
  await page.evaluate(`Promise.race([
    Promise.all(Array.from(document.images).filter(i => !i.complete).map(i => new Promise(r => {
      i.addEventListener('load', r, { once: true });
      i.addEventListener('error', r, { once: true });
    }))),
    new Promise(r => setTimeout(r, 4000)),
  ])`).catch(() => {});
}

export async function generatePdfFromHtml(html: string, opts?: PdfOptions): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForImages(page);
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

// Reads each flow element's real rendered height off a loaded page, keyed by
// the same `data-el-id` attribute the renderer already emits (and the
// frontend canvas's own reflow-measurement iframe already reads — see
// TemplateDesignerPage.tsx). Waits for images first: an unloaded <img> inside
// a richtext block reads as ~0 height, which would reintroduce a milder
// version of the same overlap bug this measurement exists to fix.
async function measureFlowHeights(page: Page, html: string, flowIds: string[]): Promise<Record<string, number>> {
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await waitForImages(page);
  const idsJson = JSON.stringify(flowIds);
  const heights = await page.evaluate(`(() => {
    const ids = ${idsJson};
    const out = {};
    for (const id of ids) {
      const el = document.querySelector('[data-el-id="' + CSS.escape(id) + '"]');
      if (el) out[id] = el.getBoundingClientRect().height;
    }
    return out;
  })()`);
  return heights as Record<string, number>;
}

// Shared two-pass core: Pass 1 renders with today's (design-time) band math;
// if the template has no flow elements there's nothing to measure, so this
// returns Pass 1 untouched with zero extra Puppeteer work. Otherwise measures
// each flow element's real height and re-renders (Pass 2) with those heights
// substituted into the band cursor math — a fixed point, since a flow
// element's own rendered height doesn't depend on where the page cursor put
// it, only on its own content/width (unchanged between passes).
async function renderWithFlowCorrection(
  page: Page,
  elements: IDesignElement[],
  ctx: RenderCtx,
  pageCfg?: ITemplatePage,
  header?: ITemplateRegion,
  footer?: ITemplateRegion,
): Promise<RenderedTemplate> {
  const pass1 = renderCustomTemplateFull(elements, ctx, pageCfg, header, footer);
  const flowIds = elements.filter((e) => FLOW_TYPES.has(e.type)).map((e) => e.id);
  if (flowIds.length === 0) return pass1;

  const flowHeightOverrides = await measureFlowHeights(page, pass1.html, flowIds);
  return renderCustomTemplateFull(elements, ctx, pageCfg, header, footer, flowHeightOverrides);
}

// Real PDF for a designer template — one browser/page serves both the
// measurement pass and the final print pass (never a second launch).
export async function generateDesignerPdf(
  elements: IDesignElement[],
  ctx: RenderCtx,
  pageCfg?: ITemplatePage,
  header?: ITemplateRegion,
  footer?: ITemplateRegion,
): Promise<{ buffer: Buffer; pageOptions: RenderedTemplate['pageOptions'] }> {
  const browser: Browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const rendered = await renderWithFlowCorrection(page, elements, ctx, pageCfg, header, footer);
    await page.setContent(rendered.html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForImages(page);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top:    `${rendered.pageOptions.marginTopPx}px`,
        right:  '0',
        bottom: `${rendered.pageOptions.marginBottomPx}px`,
        left:   '0',
      },
    });
    return { buffer: Buffer.from(pdf), pageOptions: rendered.pageOptions };
  } finally {
    await browser.close();
  }
}

// HTML-only path for preview callers (no page.pdf() call) — skips Puppeteer
// entirely for a template with no flow elements, same zero-cost behavior
// preview has today for ordinary templates.
export async function renderDesignerHtml(
  elements: IDesignElement[],
  ctx: RenderCtx,
  pageCfg?: ITemplatePage,
  header?: ITemplateRegion,
  footer?: ITemplateRegion,
): Promise<RenderedTemplate> {
  const flowIds = elements.filter((e) => FLOW_TYPES.has(e.type)).map((e) => e.id);
  if (flowIds.length === 0) return renderCustomTemplateFull(elements, ctx, pageCfg, header, footer);

  const browser: Browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    return await renderWithFlowCorrection(page, elements, ctx, pageCfg, header, footer);
  } finally {
    await browser.close();
  }
}
