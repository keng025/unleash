import { createConfig, resolveIsOss } from '../create-config.js';
import { multiProjectFromEnv } from './multi-project-from-env.js';

describe('multiProjectFromEnv', () => {
    test('returns nothing when UNLEASH_MULTI_PROJECT is unset', () => {
        expect(multiProjectFromEnv({})).toBeUndefined();
        expect(
            multiProjectFromEnv({ UNLEASH_MULTI_PROJECT: 'false' }),
        ).toBeUndefined();
    });

    test('yields a "pro" shaped config: isOss off, isEnterprise still off', () => {
        const options = multiProjectFromEnv({ UNLEASH_MULTI_PROJECT: 'true' });
        const config = createConfig({ ...options });
        // NODE_ENV=test short-circuits config.isOss, so resolve it as production would.
        expect(
            resolveIsOss(config.isEnterprise, undefined, config.ui.environment),
        ).toBe(false);
        expect(config.isEnterprise).toBe(false);
        expect(config.ui.environment).toBe('pro');
        expect(config.enterpriseVersion).toBeTruthy();
        // 'EEA' is the UI flag the bundled frontend checks before showing
        // environment management (EnvironmentTable / CreateEnvironmentButton).
        expect(
            (config.flagResolver.getAll() as Record<string, unknown>).EEA,
        ).toBe(true);
    });
});
