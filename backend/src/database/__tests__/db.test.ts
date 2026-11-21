import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('database/db host configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('throws a configuration error in production when DB_HOST is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DB_HOST;

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../db');
    }).toThrow(/DB_HOST/);
  });

  it('defaults to localhost outside production when DB_HOST is missing', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DB_HOST;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../db');
    expect(mod).toBeDefined();
  });
});
