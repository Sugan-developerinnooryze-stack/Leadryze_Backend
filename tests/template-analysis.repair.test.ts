/**
 * Repair/clamp pipeline for the PDF/Image Template Analyzer — AI output
 * can't be trusted to satisfy designElementSchema's exact bounds, so this
 * suite feeds deliberately malformed synthetic "AI output" through
 * repairAndValidateElements and asserts the result always survives the
 * REAL createTemplateSchema (the same one every hand-built template goes
 * through) rather than re-checking a duplicated set of rules.
 *
 * Run: npx jest --testPathPatterns=template-analysis.repair.test.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { repairAndValidateElements } from '../src/modules/native-crm/custom-templates/template-analysis.repair';
import { createTemplateSchema } from '../src/modules/native-crm/custom-templates/custom-template.validation';

function isValidTemplate(elements: any[]): boolean {
  return createTemplateSchema.safeParse({ name: 'AI Draft', docType: 'invoice', elements }).success;
}

describe('repairAndValidateElements', () => {
  it('returns an empty result with a warning when the AI output is not an array', () => {
    const { elements, warnings } = repairAndValidateElements({ not: 'an array' }, 'invoice');
    expect(elements).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('clamps out-of-range numeric fields into schema bounds', () => {
    const { elements } = repairAndValidateElements(
      [{ id: 'a', type: 'text', x: 999999, y: -999999, w: 0, h: 999999, fontSize: 500, lineHeight: 99 }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    const el = elements[0];
    expect(el.x).toBeLessThanOrEqual(4000);
    expect(el.y).toBeGreaterThanOrEqual(-2000);
    expect(el.w).toBeGreaterThanOrEqual(1);
    expect(el.h).toBeLessThanOrEqual(20000);
    expect(el.fontSize).toBeLessThanOrEqual(120);
    expect(el.lineHeight).toBeLessThanOrEqual(4);
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('coerces an unrecognized fontFamily to a safe default instead of dropping the element', () => {
    const { elements } = repairAndValidateElements(
      [{ id: 'a', type: 'text', x: 10, y: 10, w: 100, h: 30, fontFamily: 'Comic Sans MS' }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    expect(['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS']).toContain(elements[0].fontFamily);
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('drops an invalid color value rather than guessing a replacement', () => {
    const { elements } = repairAndValidateElements(
      [{ id: 'a', type: 'text', x: 10, y: 10, w: 100, h: 30, color: 'not-a-color', backgroundColor: '#fff' }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    expect(elements[0].color).toBeUndefined();
    expect(elements[0].backgroundColor).toBe('#fff');
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('reshapes gridCells to exactly match gridRows×gridCols', () => {
    const { elements } = repairAndValidateElements(
      [{
        id: 'g1', type: 'gridtable', x: 0, y: 0, w: 300, h: 100,
        gridRows: 2, gridCols: 3,
        gridCells: [['a', 'b']], // only 1 row, only 2 cols — mismatched on both axes
      }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    const el = elements[0];
    const cells = el.gridCells!;
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveLength(3);
    expect(cells[1]).toHaveLength(3);
    expect(cells[0][0]).toBe('a');
    expect(cells[0][1]).toBe('b');
    expect(cells[0][2]).toBe(''); // padded
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('drops an element with an unrecognized type', () => {
    const { elements, warnings } = repairAndValidateElements(
      [
        { id: 'a', type: 'chart', x: 0, y: 0, w: 100, h: 100 },
        { id: 'b', type: 'text', x: 0, y: 0, w: 100, h: 30 },
      ],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe('b');
    expect(warnings.some((w) => w.includes('unrecognized type'))).toBe(true);
  });

  it('caps the array at 200 elements', () => {
    const raw = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, type: 'text', x: 0, y: i, w: 50, h: 10 }));
    const { elements } = repairAndValidateElements(raw, 'invoice');
    expect(elements.length).toBeLessThanOrEqual(200);
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('strips a partNumber column when dataset is not "parts"', () => {
    const { elements } = repairAndValidateElements(
      [{
        id: 't1', type: 'table', x: 0, y: 0, w: 700, h: 120, dataset: 'services',
        columns: [{ key: 'name', label: 'Description' }, { key: 'partNumber', label: 'Part No.' }],
      }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    expect(elements[0].columns?.some((c: any) => c.key === 'partNumber')).toBe(false);
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('drops a totalsRows entry with an unrecognized key', () => {
    const { elements } = repairAndValidateElements(
      [{
        id: 'tot1', type: 'totals', x: 0, y: 0, w: 200, h: 100,
        totalsRows: [{ key: 'subtotal' }, { key: 'madeUpKey' }],
      }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    expect(elements[0].totalsRows).toHaveLength(1);
    expect(elements[0].totalsRows?.[0].key).toBe('subtotal');
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('regenerates a unique id when two elements share the same id', () => {
    const { elements } = repairAndValidateElements(
      [
        { id: 'dup', type: 'text', x: 0, y: 0, w: 100, h: 30 },
        { id: 'dup', type: 'text', x: 0, y: 40, w: 100, h: 30 },
      ],
      'invoice',
    );
    expect(elements).toHaveLength(2);
    expect(elements[0].id).not.toBe(elements[1].id);
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('defaults missing required x/y/w/h to a sane anchor instead of dropping the element', () => {
    const { elements } = repairAndValidateElements(
      [{ id: 'a', type: 'image' }],
      'invoice',
    );
    expect(elements).toHaveLength(1);
    expect(typeof elements[0].x).toBe('number');
    expect(typeof elements[0].w).toBe('number');
    expect(isValidTemplate(elements)).toBe(true);
  });

  it('always produces output that passes the real createTemplateSchema, even for a large adversarial batch', () => {
    const raw = [
      { id: 'x'.repeat(100), type: 'text', x: NaN, y: Infinity, w: -50, h: 'not a number', fontFamily: 123, color: {} },
      { id: 1234, type: 'table', x: 0, y: 0, w: 700, h: 120, dataset: 'weird', columns: 'not-an-array' },
      { id: 'ok', type: 'gridtable', x: 0, y: 0, w: 300, h: 100, gridRows: 999, gridCols: -5, gridCells: 'nope' },
      null,
      'a string, not an object',
      { type: 'divider', x: 0, y: 0, w: 100, h: 4 }, // missing id
    ];
    const { elements } = repairAndValidateElements(raw, 'workorder');
    expect(isValidTemplate(elements)).toBe(true);
  });

  // Real overlap patterns diagnosed live across three separate AI-analyzed
  // documents in this project (a totals block beside a table, a quote-
  // metadata box beside an address, an oversized header bleeding into a
  // richtext block) — each had to be fixed by hand before this automatic
  // resolution step existed. Only 'table' is a flow type now (see FLOW_TYPES
  // in template-analysis.repair.ts) — richtext/gridtable were narrowed out
  // since they're fixed-height absolute elements, identically positioned in
  // the canvas and the PDF, so nothing needs to be pushed clear of them
  // anymore. These tests reproduce the original shapes and assert the
  // now-correct behavior for each.
  describe('resolveFlowOverlaps (real-world patterns)', () => {
    function overlapsAnyFlow(el: any, all: any[]): boolean {
      const flow = all.filter((e) => e.type === 'table');
      if (el.type === 'table') return false;
      return flow.some((f) => f.id !== el.id && el.y < f.y + f.h && el.y + el.h > f.y);
    }

    it('pushes a totals block that was placed beside a table clear of it', () => {
      const raw = [
        { id: 'table1', type: 'table', x: 40, y: 350, w: 670, h: 300, dataset: 'services' },
        { id: 'totals1', type: 'totals', x: 500, y: 457, w: 232, h: 120 }, // beside the table, same y-range
      ];
      const { elements } = repairAndValidateElements(raw, 'quotation');
      expect(overlapsAnyFlow(elements.find((e: any) => e.id === 'totals1'), elements)).toBe(false);
      expect(isValidTemplate(elements)).toBe(true);
    });

    it('leaves a gridtable placed beside another element untouched (gridtable is no longer a flow type)', () => {
      const raw = [
        { id: 'address', type: 'text', x: 62, y: 99, w: 350, h: 110, content: '{{company.address}}' },
        { id: 'metadata', type: 'gridtable', x: 550, y: 99, w: 216, h: 166, gridRows: 3, gridCols: 1, gridCells: [['a'], ['b'], ['c']] },
      ];
      const { elements } = repairAndValidateElements(raw, 'quotation');
      // Both render as fixed-height absolute elements in the PDF, exactly as
      // laid out on canvas — no repositioning needed or performed.
      expect(elements.find((e: any) => e.id === 'address')!.y).toBe(99);
      expect(elements.find((e: any) => e.id === 'metadata')!.y).toBe(99);
      expect(isValidTemplate(elements)).toBe(true);
    });

    it('leaves an oversized header overlapping a richtext block untouched (richtext is no longer a flow type)', () => {
      const raw = [
        { id: 'terms_header', type: 'text', x: 62, y: 650, w: 430, h: 140, content: 'TERMS AND CONDITIONS' }, // absurdly tall for one line
        { id: 'terms_body', type: 'richtext', x: 62, y: 665, w: 430, h: 140, content: '{{doc.terms}}' },
      ];
      const { elements } = repairAndValidateElements(raw, 'quotation');
      expect(elements.find((e: any) => e.id === 'terms_header')!.y).toBe(650);
      expect(elements.find((e: any) => e.id === 'terms_body')!.y).toBe(665);
      expect(isValidTemplate(elements)).toBe(true);
    });

    it('resolves multiple overlapping tables plus non-flow elements beside each', () => {
      const raw = [
        { id: 'a', type: 'text', x: 500, y: 60, w: 200, h: 30, content: 'beside table1' },
        { id: 'table1', type: 'table', x: 40, y: 50, w: 400, h: 100, dataset: 'services' },
        { id: 'b', type: 'text', x: 500, y: 310, w: 200, h: 30, content: 'beside table2' },
        { id: 'table2', type: 'table', x: 40, y: 300, w: 400, h: 80, dataset: 'parts' },
        { id: 'c', type: 'text', x: 40, y: 700, w: 200, h: 30, content: 'clean, no overlap' },
      ];
      const { elements } = repairAndValidateElements(raw, 'quotation');
      const anyOverlap = elements.some((el: any) => overlapsAnyFlow(el, elements));
      expect(anyOverlap).toBe(false);
      // The genuinely non-overlapping element must be left untouched.
      expect(elements.find((e: any) => e.id === 'c')!.y).toBe(700);
      expect(isValidTemplate(elements)).toBe(true);
    });

    it('leaves non-overlapping same-row elements (e.g. a header row) completely untouched', () => {
      const raw = [
        { id: 'logo', type: 'image', x: 62, y: 54, w: 45, h: 45 },
        { id: 'company_name', type: 'text', x: 117, y: 54, w: 300, h: 35, content: '{{company.name}}' },
        { id: 'quote_title', type: 'text', x: 550, y: 54, w: 200, h: 35, content: 'QUOTE' },
        { id: 'table1', type: 'table', x: 40, y: 400, w: 400, h: 100, dataset: 'services' },
      ];
      const { elements } = repairAndValidateElements(raw, 'quotation');
      expect(elements.find((e: any) => e.id === 'logo')!.y).toBe(54);
      expect(elements.find((e: any) => e.id === 'company_name')!.y).toBe(54);
      expect(elements.find((e: any) => e.id === 'quote_title')!.y).toBe(54);
    });
  });
});
