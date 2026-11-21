import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('database connector default URL handling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it('throws in production when no database URL is configured', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../index');
    }).toThrow();
  });

  it('falls back to the local default URL outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;

    const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../index');
    }).not.toThrow();

    logSpy.mockRestore();
  });
});
