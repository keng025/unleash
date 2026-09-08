import type { Express, NextFunction, Response } from 'express';
import type { IAuthRequest } from '../routes/unleash-types.js';
import type { IUnleashServices } from '../services/index.js';
import {
    type CustomAuthHandler,
    type IAuthOption,
    IAuthType,
    type IUnleashConfig,
} from '../types/option.js';
import { AuthenticationRequired } from '../types/authentication-required.js';
import UnauthorizedError from '../error/unauthorized-error.js';
import { RoleName } from '../types/model.js';

/**
 * Lark login for Unleash via the in-house lark-auth-backoffice (V2 contract).
 *
 * Flow:
 *   GET  /auth/lark/login     → 302 {frontendUrl}/larkWeb/login?m=<module>&r=<callback>
 *   GET  /auth/lark/callback  ← lark-auth redirects with ?s=200&t=<jwt>&m=<module>...
 *                              → POST {backendUrl}/session/validateSession (Bearer t)
 *                                same call FPMS-CCMS makes → email/name
 *                              → userService.loginUserSSO(autoCreate) → session
 *
 * Roles stay inside Unleash: new users get `defaultRootRole`, admins promote
 * them in the Unleash UI. lark-auth is only the identity source.
 */
export interface LarkAuthOptions {
    frontendUrl: string;
    backendUrl: string;
    moduleCode: string;
    unleashUrl: string;
    defaultRootRole: RoleName;
    fetch?: typeof fetch;
}

const ROOT_ROLES: RoleName[] = [
    RoleName.ADMIN,
    RoleName.EDITOR,
    RoleName.VIEWER,
];
const PLACEHOLDER_EMAIL_SUFFIX = '@lark.local';

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
    const value = env[key]?.trim();
    if (!value) {
        throw new Error(`Lark auth: missing required env var ${key}`);
    }
    return value;
};

export function larkAuthOptionsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): LarkAuthOptions {
    const roleRaw = env.LARK_AUTH_DEFAULT_ROLE?.trim() || RoleName.VIEWER;
    const defaultRootRole = ROOT_ROLES.find(
        (role) => role.toLowerCase() === roleRaw.toLowerCase(),
    );
    if (!defaultRootRole) {
        throw new Error(
            `Lark auth: LARK_AUTH_DEFAULT_ROLE must be one of ${ROOT_ROLES.join(', ')}, got "${roleRaw}"`,
        );
    }
    return {
        frontendUrl: stripTrailingSlash(
            requireEnv(env, 'LARK_AUTH_FRONTEND_URL'),
        ),
        backendUrl: stripTrailingSlash(
            requireEnv(env, 'LARK_AUTH_BACKEND_URL'),
        ),
        moduleCode: requireEnv(env, 'LARK_AUTH_MODULE_CODE'),
        unleashUrl: stripTrailingSlash(requireEnv(env, 'UNLEASH_URL')),
        defaultRootRole,
    };
}

/** Flat envelope of POST /session/validateSession (权限对接文档 D1.0.1). */
interface ValidateSessionResponse {
    status?: string;
    message?: string;
    name?: string;
    email?: string;
}

class LarkLoginError extends Error {}

async function fetchLarkUser(
    { backendUrl, moduleCode, fetch: doFetch = fetch }: LarkAuthOptions,
    token: string,
    userId: string,
): Promise<{ email: string; name?: string }> {
    let body: ValidateSessionResponse;
    try {
        const res = await doFetch(`${backendUrl}/session/validateSession`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            // Same body FPMS-CCMS sends: refId = moduleCode, sessionId = userId.
            body: JSON.stringify({ refId: moduleCode, sessionId: userId }),
        });
        if (!res.ok) {
            throw new LarkLoginError(
                `Could not verify Lark login (lark-auth returned ${res.status})`,
            );
        }
        body = (await res.json()) as ValidateSessionResponse;
    } catch (e) {
        if (e instanceof LarkLoginError) throw e;
        throw new LarkLoginError('Could not verify Lark login with lark-auth');
    }

    if (body.status !== '200') {
        throw new LarkLoginError(
            `Lark login rejected by lark-auth: ${body.message ?? body.status}`,
        );
    }
    const email = body.email?.trim().toLowerCase();
    if (!email || email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)) {
        throw new LarkLoginError(
            'Your Lark account has no email address configured. Ask IT to add one before signing in.',
        );
    }
    return { email, name: body.name?.trim() || undefined };
}

export function createLarkAuthHandler(
    options: LarkAuthOptions,
): CustomAuthHandler {
    return (
        app: Express,
        config: Partial<IUnleashConfig>,
        services?: IUnleashServices,
    ): void => {
        const basePath = config.server?.baseUriPath ?? '';
        const logger = config.getLogger?.('middleware/lark-authentication.ts');
        const userService = services?.userService;
        if (!userService) {
            throw new Error('Lark auth: userService is required');
        }

        const loginPath = `${basePath}/auth/lark/login`;
        const callbackPath = `${basePath}/auth/lark/callback`;
        const callbackUrl = `${options.unleashUrl}${callbackPath}`;

        const redirectToLoginWithError = (res: Response, message: string) => {
            const params = new URLSearchParams({ errorMsg: message });
            res.redirect(`${basePath}/login?${params.toString()}`);
        };

        app.get(loginPath, (_req, res) => {
            const params = new URLSearchParams({
                m: options.moduleCode,
                r: callbackUrl,
            });
            res.redirect(
                `${options.frontendUrl}/larkWeb/login?${params.toString()}`,
            );
        });

        app.get(callbackPath, async (req: IAuthRequest, res) => {
            const q = req.query as Record<string, string | undefined>;
            // 权限对接文档 names it `token`; the V2 backend actually sends `t`.
            const token = q.t ?? q.token;
            const moduleCode = q.m;
            const userId = q.userId ?? '';

            if (q.s !== '200' || !token) {
                const reason = q.error ?? q.s ?? 'unknown';
                return redirectToLoginWithError(
                    res,
                    `Lark login failed (${reason}). You may not have access to the ${options.moduleCode} module.`,
                );
            }
            if (moduleCode && moduleCode !== options.moduleCode) {
                return redirectToLoginWithError(
                    res,
                    `Lark login returned a token for module ${moduleCode}, expected ${options.moduleCode}`,
                );
            }

            try {
                const { email, name } = await fetchLarkUser(
                    options,
                    token,
                    userId,
                );
                const user = await userService.loginUserSSO({
                    email,
                    name,
                    autoCreate: true,
                    rootRole: options.defaultRootRole,
                });
                req.session.user = user;
                logger?.info(`Lark login ok for ${email}`);
                return res.redirect(`${basePath}/`);
            } catch (e) {
                const message =
                    e instanceof LarkLoginError
                        ? e.message
                        : 'Lark login failed';
                logger?.warn(`Lark login rejected: ${(e as Error).message}`);
                return redirectToLoginWithError(res, message);
            }
        });

        const authorize = (
            req: IAuthRequest,
            res: Response,
            next: NextFunction,
        ) => {
            if (!req.user?.isAPI && req.session?.user) {
                req.user = req.session.user;
                return next();
            }
            if (req.user) {
                return next();
            }
            if (req.header('authorization')) {
                const error = new UnauthorizedError(
                    'You must log in to use Unleash.',
                );
                return res.status(error.statusCode).json(error);
            }
            const error = new AuthenticationRequired({
                type: 'password',
                path: `${basePath}/auth/simple/login`,
                message: 'You must log in to use Unleash.',
                options: [
                    {
                        type: 'lark',
                        path: loginPath,
                        message: 'Sign in with Lark',
                    },
                ],
            });
            return res.status(error.statusCode).json(error);
        };

        app.use(`${basePath}/api`, authorize);
        app.use(`${basePath}/logout`, authorize);
    };
}

/**
 * Env-driven opt-in used by server.ts and server-dev.ts: when
 * LARK_AUTH_MODULE_CODE is set, switch authentication to CUSTOM with the Lark
 * handler; otherwise return undefined and leave the default auth untouched.
 */
export function larkAuthenticationFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): Pick<IAuthOption, 'type' | 'customAuthHandler'> | undefined {
    if (!env.LARK_AUTH_MODULE_CODE) {
        return undefined;
    }
    return {
        type: IAuthType.CUSTOM,
        customAuthHandler: createLarkAuthHandler(larkAuthOptionsFromEnv(env)),
    };
}
