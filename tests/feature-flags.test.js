const { FLAGS, isEnabled, snapshot } = require('../lib/feature-flags');

describe('feature-flags', () => {
  afterEach(() => {
    for (const name of Object.values(FLAGS)) delete process.env[name];
  });

  test('all flags default to false', () => {
    const s = snapshot();
    for (const name of Object.values(FLAGS)) expect(s[name]).toBe(false);
  });

  test('env override enables a single flag', () => {
    process.env[FLAGS.IDENTITY_RESOLVER_AVAILABLE] = '1';
    expect(isEnabled(FLAGS.IDENTITY_RESOLVER_AVAILABLE)).toBe(true);
    expect(isEnabled(FLAGS.IDENTITY_RESOLVER_LEADBRIDGE)).toBe(false);
  });

  test('truthy values: 1, true, yes, on', () => {
    const key = FLAGS.IDENTITY_RESOLVER_AVAILABLE;
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env[key] = v;
      expect(isEnabled(key)).toBe(true);
    }
  });

  test('unknown flag throws', () => {
    expect(() => isEnabled('NOT_A_REAL_FLAG')).toThrow('Unknown flag');
  });

  test('falsy values disable', () => {
    const key = FLAGS.IDENTITY_RESOLVER_AVAILABLE;
    for (const v of ['0', 'false', 'no', 'off', '']) {
      process.env[key] = v;
      expect(isEnabled(key)).toBe(false);
    }
  });
});
