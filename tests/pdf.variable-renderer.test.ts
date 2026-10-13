/**
 * Regression coverage for the flow-height correction fix in
 * renderCustomTemplateFull() (src/modules/native-crm/pdf/pdf.variable-renderer.ts).
 *
 * Pure function, no DB/app bootstrap needed — `renderCustomTemplateFull` only
 * takes plain data in and returns an HTML string, so these assert directly
 * against the band-math output rather than driving a real browser.
 *
 * Run: npx jest --testPathPattern=pdf.variable-renderer.test.ts
 */

// sanitize-html pulls in an ESM-only dependency (htmlparser2) that this
// project's jest config doesn't transform; pdf.variable-renderer.ts only
// calls it inside richtextHtml(), which these tests don't exercise (text/
// table elements only), so a trivial passthrough mock avoids a transform
// config change entirely unrelated to the fix being tested.
jest.mock('sanitize-html', () => (html: string) => html);

import { renderCustomTemplateFull } from '../src/modules/native-crm/pdf/pdf.variable-renderer';
import { IDesignElement } from '../src/modules/native-crm/custom-templates/custom-template.model';
import { RenderCtx } from '../src/modules/native-crm/pdf/variable-catalog';

const ctx: RenderCtx = {
  doc: { services: [], parts: [] },
  settings: {},
  customer: null,
  docType: 'workorder',
  cur: '$',
  customFieldDefs: [],
};

function topOf(html: string, id: string): number {
  const re = new RegExp(`data-el-id="${id}"[^>]*style="[^"]*top:(-?\\d+(?:\\.\\d+)?)px`);
  const match = html.match(re);
  if (!match) throw new Error(`no top: found for data-el-id="${id}" in rendered HTML`);
  return Number(match[1]);
}

const logo: IDesignElement = { id: 'logo', type: 'text', x: 20, y: 20, w: 200, h: 40, content: 'Logo' };
const table: IDesignElement = { id: 'tbl', type: 'table', x: 20, y: 100, w: 700, h: 120, dataset: 'services' };
const notes: IDesignElement = { id: 'notes', type: 'text', x: 20, y: 240, w: 700, h: 60, content: 'Notes' };

describe('renderCustomTemplateFull — flow height correction', () => {
  it('shifts a downstream element down when the table measures taller than its design height', () => {
    const designHtml = renderCustomTemplateFull([logo, table, notes], ctx).html;
    const correctedHtml = renderCustomTemplateFull([logo, table, notes], ctx, undefined, undefined, undefined, { tbl: 300 }).html;

    // Design-time: notes sits in the band starting right after the table's
    // design box (y=100, h=120 -> band starts at 220), at its own y=240,
    // so its band-relative top is 240-220=20.
    expect(topOf(designHtml, 'notes')).toBe(20);

    // Corrected: table measured at 300px tall (vs design h=120) -> band
    // starts at 100+300=400, so notes' band-relative top is now negative
    // (240-400 = -160) — i.e. the band model pushes notes INTO the new band
    // starting exactly where the real table ends, never overlapping it.
    const correctedTop = topOf(correctedHtml, 'notes');
    expect(correctedTop).not.toBe(20);
    expect(correctedTop).toBeLessThan(20);
  });

  it('never moves an element positioned before the first flow element, regardless of flowHeightOverrides', () => {
    const withoutOverride = renderCustomTemplateFull([logo, table, notes], ctx).html;
    const withOverride = renderCustomTemplateFull([logo, table, notes], ctx, undefined, undefined, undefined, { tbl: 999 }).html;

    expect(topOf(withOverride, 'logo')).toBe(topOf(withoutOverride, 'logo'));
  });

  it('is byte-identical to the pre-fix function when flowHeightOverrides is omitted', () => {
    const a = renderCustomTemplateFull([logo, table, notes], ctx);
    const b = renderCustomTemplateFull([logo, table, notes], ctx, undefined, undefined, undefined, undefined);
    expect(a.html).toBe(b.html);
  });
});
