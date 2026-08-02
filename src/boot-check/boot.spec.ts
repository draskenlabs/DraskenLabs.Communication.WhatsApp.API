/** Guards the module graph: a cycle here fails at boot, not in a unit test. */
describe('module graph', () => {
  it('compiles without a circular dependency', async () => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      JWT_SECRET: 'x'.repeat(32),
      META_APP_ID: 'app',
      META_APP_SECRET: 'secret',
      META_REDIRECT_URI: 'https://example.test/cb',
      WEBHOOK_VERIFY_TOKEN: 'verify',
      SSO_CLIENT_ID: 'sso',
      SSO_CLIENT_SECRET: 'sso-secret',
      SSO_API_URL: 'https://sso.test',
      SSO_REDIRECT_URI: 'https://example.test/sso',
    });

    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../app.module');

    // `compile()` is the whole test: it resolves every provider in the graph,
    // which is where a cycle or a missing export shows up. Not closed on
    // purpose — nothing was ever connected, so there is nothing to disconnect.
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(mod).toBeDefined();

    // The env above is everything a deployment must supply. Neither the docs
    // nor the dev-only connect endpoint is in it, and both have to stay off
    // for a deployment that never mentions them.
    const { ConfigService } = await import('@nestjs/config');
    const config = mod.get(ConfigService);
    expect(String(config.get('SWAGGER_ENABLED')).toLowerCase()).not.toBe('true');
    expect(String(config.get('ALLOW_MANUAL_CONNECT')).toLowerCase()).not.toBe('true');
  }, 60000);
});
