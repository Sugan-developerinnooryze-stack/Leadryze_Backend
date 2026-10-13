import { parseDateRange, normalizeTimezone } from '../src/modules/analytics/analytics.service';
import { safeDecryptValue, cleanDomain, escapeCsvField, rowsToCsv } from '../src/modules/analytics/analytics.export.service';
import { encrypt } from '../src/utils/crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '01234567890123456789012345678901';
});

describe('Analytics Timezone & Export Acceptance Tests', () => {
  describe('International Timezone Boundary Calculation', () => {
    test('1. Date range in Asia/Kolkata (UTC+5:30)', () => {
      // 2026-09-01 to 2026-09-30 in Asia/Kolkata
      const range = parseDateRange({
        preset: 'custom',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        timezone: 'Asia/Kolkata'
      });

      // Start: 2026-09-01 00:00:00 IST -> 2026-08-31 18:30:00 UTC
      expect(range.startUtc.toISOString()).toBe('2026-08-31T18:30:00.000Z');
      // End exclusive: 2026-10-01 00:00:00 IST -> 2026-09-30 18:30:00 UTC
      expect(range.endExclusiveUtc.toISOString()).toBe('2026-09-30T18:30:00.000Z');
      expect(range.timeZone).toBe('Asia/Kolkata');
      expect(range.localStartDate).toBe('2026-09-01');
      expect(range.localEndDate).toBe('2026-09-30');
    });

    test('2. Date range in Asia/Singapore (UTC+8)', () => {
      const range = parseDateRange({
        preset: 'custom',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        timezone: 'Asia/Singapore'
      });

      // Start: 2026-09-01 00:00:00 SGT -> 2026-08-31 16:00:00 UTC
      expect(range.startUtc.toISOString()).toBe('2026-08-31T16:00:00.000Z');
      // End exclusive: 2026-10-01 00:00:00 SGT -> 2026-09-30 16:00:00 UTC
      expect(range.endExclusiveUtc.toISOString()).toBe('2026-09-30T16:00:00.000Z');
      expect(range.timeZone).toBe('Asia/Singapore');
    });

    test('3. America/New_York across Spring DST transition (23-hour day on 2026-03-08)', () => {
      // In 2026, US DST begins on Sunday, March 8, 2026 (clock jumps from 02:00 to 03:00)
      const range = parseDateRange({
        preset: 'custom',
        startDate: '2026-03-08',
        endDate: '2026-03-08',
        timezone: 'America/New_York'
      });

      // Start: 2026-03-08 00:00:00 EST (UTC-5) -> 2026-03-08 05:00:00 UTC
      expect(range.startUtc.toISOString()).toBe('2026-03-08T05:00:00.000Z');
      // Next day: 2026-03-09 00:00:00 EDT (UTC-4) -> 2026-03-09 04:00:00 UTC (difference is exactly 23 hours)
      expect(range.endExclusiveUtc.toISOString()).toBe('2026-03-09T04:00:00.000Z');
      const diffHours = (range.endExclusiveUtc.getTime() - range.startUtc.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBe(23);
    });

    test('4. Europe/London across Spring DST transition (23-hour day on 2026-03-29)', () => {
      // In 2026, UK DST begins on Sunday, March 29, 2026 (clock jumps from 01:00 to 02:00)
      const range = parseDateRange({
        preset: 'custom',
        startDate: '2026-03-29',
        endDate: '2026-03-29',
        timezone: 'Europe/London'
      });

      // Start: 2026-03-29 00:00:00 GMT (UTC+0) -> 2026-03-29 00:00:00 UTC
      expect(range.startUtc.toISOString()).toBe('2026-03-29T00:00:00.000Z');
      // Next day: 2026-03-30 00:00:00 BST (UTC+1) -> 2026-03-29 23:00:00 UTC (difference is 23 hours)
      expect(range.endExclusiveUtc.toISOString()).toBe('2026-03-29T23:00:00.000Z');
      const diffHours = (range.endExclusiveUtc.getTime() - range.startUtc.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBe(23);
    });

    test('5. Half-open boundary matching: [startUtc, endExclusiveUtc)', () => {
      const range = parseDateRange({
        preset: 'custom',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        timezone: 'Asia/Kolkata'
      });

      const exactlyAtStart = new Date(range.startUtc.getTime());
      const justBeforeEnd = new Date(range.endExclusiveUtc.getTime() - 1);
      const exactlyAtEnd = new Date(range.endExclusiveUtc.getTime());

      // Helper check logic matching createdAt query: createdAt >= startUtc && createdAt < endExclusiveUtc
      const isIncluded = (d: Date) => d >= range.startUtc && d < range.endExclusiveUtc;

      expect(isIncluded(exactlyAtStart)).toBe(true);
      expect(isIncluded(justBeforeEnd)).toBe(true);
      expect(isIncluded(exactlyAtEnd)).toBe(false);
    });

    test('6. Year-end boundary spanning Dec 31 to Jan 1', () => {
      const range = parseDateRange({
        preset: 'custom',
        startDate: '2026-12-31',
        endDate: '2027-01-01',
        timezone: 'Asia/Kolkata'
      });

      expect(range.startUtc.toISOString()).toBe('2026-12-30T18:30:00.000Z');
      expect(range.endExclusiveUtc.toISOString()).toBe('2027-01-01T18:30:00.000Z');
    });

    test('7. Normalize legacy Asia/Calcutta to Asia/Kolkata', () => {
      expect(normalizeTimezone('Asia/Calcutta')).toBe('Asia/Kolkata');
      expect(normalizeTimezone('UTC')).toBe('UTC');
      expect(normalizeTimezone('Invalid/Zone')).toBe('Asia/Kolkata');
    });
  });

  describe('Contact Field Decryption & Sanitization', () => {
    test('1. Decrypts AES-256-GCM encrypted email and phone strings', () => {
      const rawEmail = 'alex.morgan@techcorp.io';
      const rawPhone = '+91 98765 43210';
      const encryptedEmail = encrypt(rawEmail);
      const encryptedPhone = encrypt(rawPhone);

      // Verify the encrypted value has the colon-separated hex format iv:tag:data
      expect(encryptedEmail).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i);
      expect(encryptedPhone).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i);

      // safeDecryptValue must return original readable value
      expect(safeDecryptValue(encryptedEmail)).toBe(rawEmail);
      expect(safeDecryptValue(encryptedPhone)).toBe(rawPhone);
    });

    test('2. Preserves plain text without alteration', () => {
      const plainEmail = 'support@leadryze.ai';
      const plainPhone = '+1 555-0199';

      expect(safeDecryptValue(plainEmail)).toBe(plainEmail);
      expect(safeDecryptValue(plainPhone)).toBe(plainPhone);
    });

    test('3. Handles missing or empty values gracefully', () => {
      expect(safeDecryptValue(null)).toBe('');
      expect(safeDecryptValue(undefined)).toBe('');
      expect(safeDecryptValue('')).toBe('');
    });

    test('4. cleanDomain extracts hostname and cleans encrypted or full URLs', () => {
      expect(cleanDomain('https://balajitechsolutions.in/about')).toBe('balajitechsolutions.in');
      expect(cleanDomain('http://subdomain.company.com:8080/path')).toBe('subdomain.company.com');
      expect(cleanDomain('plaindomain.co.uk')).toBe('plaindomain.co.uk');

      // Encrypted domain
      const encryptedDomain = encrypt('https://apexgroup.com');
      expect(cleanDomain(encryptedDomain)).toBe('apexgroup.com');
    });
  });

  describe('CSV Generation & Security', () => {
    test('1. Generates clean CSV with UTF-8 BOM and uppercase headers', () => {
      const sampleHeaders = ['S.NO', 'LEAD ID', 'EMAIL', 'PHONE', 'COMPANY'];
      const sampleRows = [
        sampleHeaders,
        [
          1,
          'lead_1',
          safeDecryptValue(encrypt('john@example.com')),
          safeDecryptValue(encrypt('+1234567890')),
          'Acme Corp'
        ]
      ];

      const csvStr = rowsToCsv(sampleRows);
      // Starts with UTF-8 BOM (code 0xFEFF)
      expect(csvStr.charCodeAt(0)).toBe(0xFEFF);
      // Contains uppercase headers including S.NO
      expect(csvStr).toContain('S.NO,LEAD ID,EMAIL,PHONE,COMPANY');
      // Contains decrypted values, not ciphertexts
      expect(csvStr).toContain('1,lead_1,john@example.com');
      expect(csvStr).toContain('+1234567890');
      expect(csvStr).not.toMatch(/[0-9a-f]{24}:[0-9a-f]{32}:/);
    });

    test('2. Prevents formula injection in CSV text cells', () => {
      expect(escapeCsvField('=cmd|/c calc!A0')).toBe("'=cmd|/c calc!A0");
      expect(escapeCsvField('+dangerous_formula()')).toBe("'+dangerous_formula()");
      expect(escapeCsvField('@sum(1,2)')).toBe('"\'@sum(1,2)\"');
      expect(escapeCsvField('-risk_value')).toBe("'-risk_value");
      expect(escapeCsvField('normal text')).toBe('normal text');
      expect(escapeCsvField('has,comma')).toBe('"has,comma"');
      expect(escapeCsvField('has"quote')).toBe('"has""quote"');
    });
  });
});
