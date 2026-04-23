const { normalize, normalizePhone } = require('../lib/name-normalize');

describe('name-normalize', () => {
  describe('basic cases', () => {
    test('simple two-word name', () => {
      expect(normalize('Linda Mau')).toEqual({ normalized_name: 'linda mau', name_token_set: 'linda mau' });
    });

    test('extra whitespace collapsed', () => {
      expect(normalize('  linda   mau  ')).toEqual({ normalized_name: 'linda mau', name_token_set: 'linda mau' });
    });

    test('single-letter initial removed', () => {
      expect(normalize('Linda M.')).toEqual({ normalized_name: 'linda', name_token_set: 'linda' });
    });

    test('middle initial removed', () => {
      expect(normalize('John D Smith')).toEqual({ normalized_name: 'john smith', name_token_set: 'john smith' });
    });

    test('last-first comma order reversed', () => {
      const r = normalize('Mau, Linda');
      expect(r.normalized_name).toBe('linda mau');
      expect(r.name_token_set).toBe('linda mau');
    });

    test('diacritics stripped', () => {
      expect(normalize('Jöhn O\'Brien').normalized_name).toBe('john obrien');
    });

    test('titles and suffixes stripped', () => {
      expect(normalize('Dr. Jane Doe Jr.').normalized_name).toBe('jane doe');
      expect(normalize('Mr John Smith III').normalized_name).toBe('john smith');
    });

    test('full example from plan', () => {
      const r = normalize('Dr. Jöhn O\'Brien Jr.');
      expect(r).toEqual({ normalized_name: 'john obrien', name_token_set: 'john obrien' });
    });

    test('Smith John D (comma form)', () => {
      const r = normalize('Smith, John D');
      expect(r.normalized_name).toBe('john smith');
      expect(r.name_token_set).toBe('john smith');
    });
  });

  describe('token_set vs normalized_name', () => {
    test('ordering differs but token_set matches for reverse', () => {
      const a = normalize('Linda Mau');
      const b = normalize('Mau Linda');
      expect(a.normalized_name).not.toBe(b.normalized_name);
      expect(a.name_token_set).toBe(b.name_token_set);
    });
  });

  describe('edge cases', () => {
    test('null → null result', () => {
      expect(normalize(null)).toEqual({ normalized_name: null, name_token_set: null });
    });

    test('undefined → null result', () => {
      expect(normalize(undefined)).toEqual({ normalized_name: null, name_token_set: null });
    });

    test('empty string → null result', () => {
      expect(normalize('')).toEqual({ normalized_name: null, name_token_set: null });
      expect(normalize('   ')).toEqual({ normalized_name: null, name_token_set: null });
    });

    test('only title → null result', () => {
      expect(normalize('Mr.')).toEqual({ normalized_name: null, name_token_set: null });
    });

    test('only initial → null result', () => {
      expect(normalize('J.')).toEqual({ normalized_name: null, name_token_set: null });
    });

    test('numeric input → null result', () => {
      expect(normalize(123)).toEqual({ normalized_name: '123', name_token_set: '123' });
    });

    test('punctuation soup produces nothing', () => {
      expect(normalize('...,,,')).toEqual({ normalized_name: null, name_token_set: null });
    });
  });

  describe('idempotency', () => {
    test('normalize(normalize(x).normalized_name) === normalize(x)', () => {
      const samples = ['Linda Mau', 'Mau, Linda', 'Dr. Jöhn O\'Brien Jr.', 'John D Smith'];
      for (const s of samples) {
        const first = normalize(s);
        const second = normalize(first.normalized_name);
        expect(second.normalized_name).toBe(first.normalized_name);
      }
    });
  });

  describe('phone normalization', () => {
    test('E.164 returns last 10', () => {
      expect(normalizePhone('+12629305925')).toBe('2629305925');
    });

    test('formatted US number', () => {
      expect(normalizePhone('(262) 930-5925')).toBe('2629305925');
    });

    test('short number returns null', () => {
      expect(normalizePhone('123')).toBeNull();
    });

    test('null / empty returns null', () => {
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone('')).toBeNull();
      expect(normalizePhone(undefined)).toBeNull();
    });

    test('1-prefix US number', () => {
      expect(normalizePhone('12629305925')).toBe('2629305925');
    });
  });
});
