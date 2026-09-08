import type { IFlags } from '../types/experimental.js';
import type { IUnleashOptions } from '../types/option.js';
import version from './version.js';

/**
 * UNLEASH_MULTI_PROJECT=true lifts the OSS single-project / three-environment
 * gate by running the server in the same shape as the hosted "Pro" plan:
 *   - `enterpriseVersion` set   → frontend `isOss()` becomes false
 *   - `ui.environment = 'pro'`  → backend `isEnterprise` stays false, `isOss` false
 *   - UI flag `EEA`             → environment management pages are unlocked
 * Enterprise-only code paths (change requests, private projects, SSO pages)
 * remain disabled. See resolveIsOss() in create-config.ts.
 *
 * Callers that build their own `experimental.flags` must spread
 * `multiProjectFlags()` into it, since a later `experimental` key would
 * otherwise replace this one (see server-dev.ts).
 */
export function multiProjectEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env.UNLEASH_MULTI_PROJECT?.toLowerCase() === 'true';
}

// 'EEA' is not an OSS flag key, hence the cast.
export const multiProjectFlags = (
    env: NodeJS.ProcessEnv = process.env,
): Partial<IFlags> =>
    multiProjectEnabled(env) ? ({ EEA: true } as Partial<IFlags>) : {};

export function multiProjectFromEnv(
    env: NodeJS.ProcessEnv = process.env,
):
    | Pick<IUnleashOptions, 'enterpriseVersion' | 'ui' | 'experimental'>
    | undefined {
    if (!multiProjectEnabled(env)) {
        return undefined;
    }
    return {
        enterpriseVersion: version,
        ui: { environment: 'pro' },
        experimental: { flags: multiProjectFlags(env) as IFlags },
    };
}
