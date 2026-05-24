const { deriveSourceForRow, deriveSourceFieldsForRow, phoneKey } = require('../lib/customer-source-fill');

describe('deriveSourceForRow — fill nulls only, resolve via mappings', () => {
  const mappings = {
    'thumbtack j': 'Thumbtack Jacksonville',
    'thumbtack t': 'Thumbtack Tampa',
    'google tampa': 'Google Tampa',
    'site': 'Site Request',
  };

  test('null source + OP company maps → returns canonical source', () => {
    const row = { id: 1, source: null };
    const convs = [{ company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceForRow(row, mappings, convs)).toBe('Thumbtack Jacksonville');
  });

  test('newest conversation wins when multiple', () => {
    const row = { id: 1, source: null };
    const convs = [
      { company: 'Thumbtack T', last_event_at: '2026-01-01T00:00:00Z' },
      { company: 'Google Tampa', last_event_at: '2026-04-01T00:00:00Z' },
    ];
    expect(deriveSourceForRow(row, mappings, convs)).toBe('Google Tampa');
  });

  test('skips conversations without company and uses next one', () => {
    const row = { id: 1, source: null };
    const convs = [
      { company: null, last_event_at: '2026-04-20T00:00:00Z' }, // newest but no company
      { company: 'Site', last_event_at: '2026-04-18T00:00:00Z' },
    ];
    expect(deriveSourceForRow(row, mappings, convs)).toBe('Site Request');
  });

  test('non-null source → skip (fill-nulls-only)', () => {
    const row = { id: 1, source: 'Existing Value' };
    const convs = [{ company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceForRow(row, mappings, convs)).toBeNull();
  });

  test('empty string source is treated as null', () => {
    const row = { id: 1, source: '   ' };
    const convs = [{ company: 'Thumbtack T', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceForRow(row, mappings, convs)).toBe('Thumbtack Tampa');
  });

  test('no conversations → null', () => {
    expect(deriveSourceForRow({ id: 1, source: null }, mappings, [])).toBeNull();
    expect(deriveSourceForRow({ id: 1, source: null }, mappings, null)).toBeNull();
  });

  test('company present but no mapping → null (no guessing)', () => {
    const row = { id: 1, source: null };
    const convs = [{ company: 'Unknown Company', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceForRow(row, mappings, convs)).toBeNull();
  });

  test('case-insensitive company lookup', () => {
    const row = { id: 1, source: null };
    const convs = [{ company: 'THUMBTACK J', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceForRow(row, mappings, convs)).toBe('Thumbtack Jacksonville');
  });

  test('null row → null', () => {
    expect(deriveSourceForRow(null, mappings, [])).toBeNull();
  });
});

describe('deriveSourceFieldsForRow — two-field attribution (migration 050)', () => {
  const mappings = {
    'thumbtack j': 'Thumbtack Jacksonville',
    'thumbtack m': 'Thumbtack Miami',
  };

  test('null source + OP company maps → returns canonical + raw company tag', () => {
    const row = { id: 1, source: null };
    const convs = [{ company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceFieldsForRow(row, mappings, convs))
      .toEqual({ source: 'Thumbtack Jacksonville', source_raw: 'Thumbtack J' });
  });

  test('preserves original raw casing in source_raw', () => {
    const row = { id: 1, source: null };
    const convs = [{ company: 'THUMBTACK M', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceFieldsForRow(row, mappings, convs))
      .toEqual({ source: 'Thumbtack Miami', source_raw: 'THUMBTACK M' });
  });

  test('non-null source → null (fill-nulls-only)', () => {
    const row = { id: 1, source: 'Existing' };
    const convs = [{ company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceFieldsForRow(row, mappings, convs)).toBeNull();
  });

  test('unmapped company → null', () => {
    const row = { id: 1, source: null };
    const convs = [{ company: 'Unknown', last_event_at: '2026-04-20T00:00:00Z' }];
    expect(deriveSourceFieldsForRow(row, mappings, convs)).toBeNull();
  });
});

describe('phoneKey', () => {
  test('returns last 10 digits', () => {
    expect(phoneKey('+12629305925')).toBe('2629305925');
    expect(phoneKey('(262) 930-5925')).toBe('2629305925');
  });
  test('invalid → null', () => {
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey('123')).toBeNull();
  });
});
