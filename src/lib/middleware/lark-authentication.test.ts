import express from 'express';
import supertest from 'supertest';
import type { IAuthRequest } from '../routes/unleash-types.js';
import { RoleName } from '../types/model.js';
import { IAuthType } from '../types/option.js';
import {
    createLarkAuthHandler,
    larkAuthenticationFromEnv,
    larkAuthOptionsFromEnv,
    type LarkAuthOptions,
} from './lark-authentication.js';

const baseOptions = (
    overrides: Partial<LarkAuthOptions> = {},
): LarkAuthOptions => ({
    frontendUrl: 'https://lark-auth.example.com',
    backendUrl: 'https://lark-auth-api.example.com',
    moduleCode: 'UNLEASH',
    unleashUrl: 'https://flags.example.com',
    defaultRootRole: RoleName.VIEWER,
    fetch: async () => {
        throw new Error('fetch not expected');
    },
    ...overrides,
});

// Flat envelope of POST /session/validateSession (same call FPMS-CCMS makes).
const fakeValidateSession = (user: Record<string, unknown>) =>
    (async () =>
        new Response(
            JSON.stringify({
                status: '200',
                message: 'SUCCESS',
                refId: 'ref-1',
                userId: 'u1',
                ...user,
            }),
            { status: 200 },
        )) as unknown as typeof fetch;

const buildApp = (options: LarkAuthOptions, basePath = '') => {
    const app = express();
    const session: Record<string, any> = {};
    app.use((req: IAuthRequest, _res, next) => {
        req.session = session;
        next();
    });

    const loginCalls: any[] = [];
    const userService = {
        loginUserSSO: async (req: any) => {
            loginCalls.push(req);
            return { id: 42, email: req.email, name: req.name };
        },
    };

    createLarkAuthHandler(options)(
        app,
        { server: { baseUriPath: basePath } } as any,
        { userService } as any,
    );

    app.get(`${basePath}/api/admin/whoami`, (req: IAuthRequest, res) => {
        res.status(200).json(req.user);
    });

    return { request: supertest(app), session, loginCalls };
};

describe('larkAuthOptionsFromEnv', () => {
    test('reads the four required variables and defaults the role to Viewer', () => {
        const options = larkAuthOptionsFromEnv({
            LARK_AUTH_FRONTEND_URL: 'https://fe/',
            LARK_AUTH_BACKEND_URL: 'https://be/',
            LARK_AUTH_MODULE_CODE: 'UNLEASH',
            UNLEASH_URL: 'https://flags/',
        });
        expect(options).toMatchObject({
            frontendUrl: 'https://fe',
            backendUrl: 'https://be',
            moduleCode: 'UNLEASH',
            unleashUrl: 'https://flags',
            defaultRootRole: RoleName.VIEWER,
        });
    });

    test('throws when a required variable is missing', () => {
        expect(() =>
            larkAuthOptionsFromEnv({
                LARK_AUTH_FRONTEND_URL: 'https://fe',
                LARK_AUTH_BACKEND_URL: 'https://be',
                UNLEASH_URL: 'https://flags',
            }),
        ).toThrow(/LARK_AUTH_MODULE_CODE/);
    });

    test('rejects an unknown default role', () => {
        expect(() =>
            larkAuthOptionsFromEnv({
                LARK_AUTH_FRONTEND_URL: 'https://fe',
                LARK_AUTH_BACKEND_URL: 'https://be',
                LARK_AUTH_MODULE_CODE: 'UNLEASH',
                UNLEASH_URL: 'https://flags',
                LARK_AUTH_DEFAULT_ROLE: 'Superuser',
            }),
        ).toThrow(/LARK_AUTH_DEFAULT_ROLE/);
    });
});

describe('larkAuthenticationFromEnv', () => {
    test('returns nothing when LARK_AUTH_MODULE_CODE is unset so default auth applies', () => {
        expect(larkAuthenticationFromEnv({})).toBeUndefined();
    });

    test('returns a CUSTOM authentication block when the Lark variables are set', () => {
        const auth = larkAuthenticationFromEnv({
            LARK_AUTH_FRONTEND_URL: 'https://fe',
            LARK_AUTH_BACKEND_URL: 'https://be',
            LARK_AUTH_MODULE_CODE: 'UNLEASH',
            UNLEASH_URL: 'https://flags',
        });
        expect(auth?.type).toBe(IAuthType.CUSTOM);
        expect(typeof auth?.customAuthHandler).toBe('function');
    });
});

describe('unauthenticated /api requests', () => {
    test('return 401 with a Lark login option and the password fallback path', async () => {
        const { request } = buildApp(baseOptions());
        const res = await request.get('/api/admin/whoami').expect(401);
        expect(res.body.type).toBe('password');
        expect(res.body.path).toBe('/auth/simple/login');
        expect(res.body.options).toEqual([
            {
                type: 'lark',
                path: '/auth/lark/login',
                message: 'Sign in with Lark',
            },
        ]);
    });

    test('return a plain 401 when an authorization header is present', async () => {
        const { request } = buildApp(baseOptions());
        const res = await request
            .get('/api/admin/whoami')
            .set('authorization', 'some-token')
            .expect(401);
        expect(res.body.options).toBeUndefined();
    });

    test('honour the base path in login option and callback', async () => {
        const { request } = buildApp(baseOptions(), '/unleash');
        const res = await request.get('/unleash/api/admin/whoami').expect(401);
        expect(res.body.options[0].path).toBe('/unleash/auth/lark/login');
    });
});

describe('GET /auth/lark/login', () => {
    test('redirects to the lark-auth frontend with module code and callback', async () => {
        const { request } = buildApp(baseOptions());
        const res = await request.get('/auth/lark/login').expect(302);
        const location = new URL(res.headers.location);
        expect(location.origin + location.pathname).toBe(
            'https://lark-auth.example.com/larkWeb/login',
        );
        expect(location.searchParams.get('m')).toBe('UNLEASH');
        expect(location.searchParams.get('r')).toBe(
            'https://flags.example.com/auth/lark/callback',
        );
    });
});

describe('GET /auth/lark/callback', () => {
    test('verifies the token with lark-auth, logs the user in and redirects home', async () => {
        const seen: {
            url?: string;
            auth?: string;
            body?: any;
            method?: string;
        } = {};
        const fetch = (async (url: string, init: RequestInit) => {
            seen.url = url;
            seen.method = init.method;
            seen.auth = (init.headers as Record<string, string>).authorization;
            seen.body = JSON.parse(String(init.body));
            return fakeValidateSession({
                email: 'Alice@Example.com',
                name: 'Alice',
            })(url, init);
        }) as unknown as typeof fetch;

        const { request, session, loginCalls } = buildApp(
            baseOptions({ fetch }),
        );
        const res = await request
            .get('/auth/lark/callback?s=200&t=jwt-123&m=UNLEASH&userId=u1')
            .expect(302);

        expect(res.headers.location).toBe('/');
        expect(seen.url).toBe(
            'https://lark-auth-api.example.com/session/validateSession',
        );
        expect(seen.method).toBe('POST');
        expect(seen.auth).toBe('Bearer jwt-123');
        expect(seen.body).toEqual({ refId: 'UNLEASH', sessionId: 'u1' });
        expect(loginCalls).toEqual([
            {
                email: 'alice@example.com',
                name: 'Alice',
                autoCreate: true,
                rootRole: RoleName.VIEWER,
            },
        ]);
        expect(session.user).toMatchObject({ id: 42 });
    });

    test('accepts the documented `token` query name as an alias of `t`', async () => {
        const { request, loginCalls } = buildApp(
            baseOptions({
                fetch: fakeValidateSession({
                    email: 'd@example.com',
                    name: 'D',
                }),
            }),
        );
        await request
            .get('/auth/lark/callback?s=200&token=jwt-9&m=UNLEASH&userId=u4')
            .expect(302);
        expect(loginCalls).toHaveLength(1);
    });

    test('treats a non-200 business status from lark-auth as a failed login', async () => {
        const fetch = (async () =>
            new Response(
                JSON.stringify({
                    status: '403',
                    message: 'NO_PERMISSION',
                    refId: 'r',
                }),
                { status: 200 },
            )) as unknown as typeof fetch;
        const { request, loginCalls } = buildApp(baseOptions({ fetch }));
        const res = await request
            .get('/auth/lark/callback?s=200&t=jwt&m=UNLEASH&userId=u5')
            .expect(302);
        const location = new URL(res.headers.location, 'http://x');
        expect(location.searchParams.get('errorMsg')).toMatch(/NO_PERMISSION/);
        expect(loginCalls).toEqual([]);
    });

    test('a logged-in session is then accepted on /api', async () => {
        const { request, session } = buildApp(baseOptions());
        session.user = { id: 7, email: 'bob@example.com' };
        const res = await request.get('/api/admin/whoami').expect(200);
        expect(res.body.email).toBe('bob@example.com');
    });

    test('redirects to login with an error when lark-auth denied access', async () => {
        const { request, loginCalls } = buildApp(baseOptions());
        const res = await request
            .get('/auth/lark/callback?s=403&error=no_access&m=UNLEASH')
            .expect(302);
        const location = new URL(res.headers.location, 'http://x');
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('errorMsg')).toMatch(/no_access/);
        expect(loginCalls).toEqual([]);
    });

    test('rejects a token that lark-auth does not accept', async () => {
        const fetch = (async () =>
            new Response('unauthorized', {
                status: 401,
            })) as unknown as typeof fetch;
        const { request, loginCalls } = buildApp(baseOptions({ fetch }));
        const res = await request
            .get('/auth/lark/callback?s=200&t=bad&m=UNLEASH&userId=u1')
            .expect(302);
        const location = new URL(res.headers.location, 'http://x');
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('errorMsg')).toMatch(/verify/i);
        expect(loginCalls).toEqual([]);
    });

    test('rejects the lark-auth placeholder email so no unidentifiable account is created', async () => {
        const { request, loginCalls } = buildApp(
            baseOptions({
                fetch: fakeValidateSession({
                    email: 'ou_abc@lark.local',
                    name: 'No Mail',
                }),
            }),
        );
        const res = await request
            .get('/auth/lark/callback?s=200&t=jwt&m=UNLEASH&userId=u2')
            .expect(302);
        const location = new URL(res.headers.location, 'http://x');
        expect(location.searchParams.get('errorMsg')).toMatch(/email/i);
        expect(loginCalls).toEqual([]);
    });

    test('rejects a callback for a different module code', async () => {
        const { request, loginCalls } = buildApp(
            baseOptions({
                fetch: fakeValidateSession({ email: 'c@example.com' }),
            }),
        );
        const res = await request
            .get('/auth/lark/callback?s=200&t=jwt&m=OTHER&userId=u3')
            .expect(302);
        const location = new URL(res.headers.location, 'http://x');
        expect(location.searchParams.get('errorMsg')).toMatch(/module/i);
        expect(loginCalls).toEqual([]);
    });
});
