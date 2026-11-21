describe('prisma client initialization', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('throws when DATABASE_URL is missing in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../prisma');
      });
    }).toThrow(/DATABASE_URL is not set/);
  });

  it('falls back to the local database in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../prisma');
      });
    }).not.toThrow();
  });
});
