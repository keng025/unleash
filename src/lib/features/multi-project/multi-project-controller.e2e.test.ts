import dbInit, {
    type ITestDb,
} from '../../../test/e2e/helpers/database-init.js';
import {
    type IUnleashTest,
    setupAppWithCustomAuth,
    setupAppWithCustomConfig,
} from '../../../test/e2e/helpers/test-helper.js';
import getLogger from '../../../test/fixtures/no-logger.js';
import { multiProjectFromEnv } from '../../util/multi-project-from-env.js';
import type { IAuthRequest } from '../../routes/unleash-types.js';
import type { IUnleashServices } from '../../services/index.js';
import { RoleName } from '../../types/model.js';

let app: IUnleashTest;
let db: ITestDb;

// Creating a project assigns the owner role to the caller, so the request
// must carry a real (persisted) admin user rather than the no-auth dummy.
const loginAsAdmin = (
    application: any,
    _config: unknown,
    { userService }: IUnleashServices,
) => {
    application.use('/api/admin/', async (req: IAuthRequest, _res, next) => {
        req.user = await userService.loginUserSSO({
            email: 'multi-project-admin@example.com',
            autoCreate: true,
            rootRole: RoleName.ADMIN,
        });
        next();
    });
};

beforeAll(async () => {
    db = await dbInit('multi_project_api_serial', getLogger);
    app = await setupAppWithCustomAuth(
        db.stores,
        loginAsAdmin,
        { ...multiProjectFromEnv({ UNLEASH_MULTI_PROJECT: 'true' }) },
        db.rawDatabase,
    );
});

afterAll(async () => {
    await app.destroy();
    await db.destroy();
});

describe('projects', () => {
    test('POST /api/admin/projects creates a second project', async () => {
        const { body } = await app.request
            .post('/api/admin/projects')
            .send({ id: 'promotion', name: 'Promotion' })
            .expect(201);
        expect(body).toMatchObject({ id: 'promotion', name: 'Promotion' });
        expect(body.environments).toContain('development');

        const list = await app.request.get('/api/admin/projects').expect(200);
        expect(list.body.projects.map((p: any) => p.id).sort()).toEqual([
            'default',
            'promotion',
        ]);
    });

    test('POST /api/admin/projects/validate accepts a free id and rejects a taken one', async () => {
        await app.request
            .post('/api/admin/projects/validate')
            .send({ id: 'payment' })
            .expect(200);
        await app.request
            .post('/api/admin/projects/validate')
            .send({ id: 'default' })
            .expect(409);
        await app.request
            .post('/api/admin/projects/validate')
            .send({ id: 'has spaces' })
            .expect(400);
    });

    test('PUT /api/admin/projects/:id renames the project', async () => {
        await app.request
            .put('/api/admin/projects/promotion')
            .send({ name: 'Promotion Team', description: 'promo flags' })
            .expect(200);
        const { body } = await app.request
            .get('/api/admin/projects/promotion/overview')
            .expect(200);
        expect(body.name).toBe('Promotion Team');
    });

    test('DELETE /api/admin/projects/:id removes it but keeps default', async () => {
        await app.request.delete('/api/admin/projects/promotion').expect(200);
        await app.request.delete('/api/admin/projects/default').expect(403);
        const list = await app.request.get('/api/admin/projects').expect(200);
        expect(list.body.projects.map((p: any) => p.id)).toEqual(['default']);
    });
});

describe('environments', () => {
    test('POST /api/admin/environments adds a fourth environment', async () => {
        const { body } = await app.request
            .post('/api/admin/environments')
            .send({ name: 'qat', type: 'test' })
            .expect(201);
        expect(body).toMatchObject({
            name: 'qat',
            type: 'test',
            enabled: true,
        });

        const list = await app.request
            .get('/api/admin/environments')
            .expect(200);
        expect(list.body.environments.map((e: any) => e.name)).toContain('qat');
    });

    test('POST /api/admin/environments/validate rejects a taken name', async () => {
        await app.request
            .post('/api/admin/environments/validate')
            .send({ name: 'stress' })
            .expect(200);
        await app.request
            .post('/api/admin/environments/validate')
            .send({ name: 'qat' })
            .expect(409);
    });

    test('PUT /api/admin/environments/update/:name changes type and sort order', async () => {
        const { body } = await app.request
            .put('/api/admin/environments/update/qat')
            .send({ type: 'preproduction', sortOrder: 42 })
            .expect(200);
        expect(body).toMatchObject({ name: 'qat', type: 'preproduction' });
        const env = await app.request
            .get('/api/admin/environments/qat')
            .expect(200);
        expect(env.body.sortOrder).toBe(42);
    });

    test('DELETE /api/admin/environments/:name removes it', async () => {
        await app.request.delete('/api/admin/environments/qat').expect(200);
        await app.request.get('/api/admin/environments/qat').expect(404);
    });
});

describe('gating', () => {
    test('the write routes are not mounted in plain OSS mode', async () => {
        const ossDb = await dbInit('multi_project_api_oss_serial', getLogger);
        const ossApp = await setupAppWithCustomConfig(
            ossDb.stores,
            { isOss: true },
            ossDb.rawDatabase,
        );
        try {
            await ossApp.request
                .post('/api/admin/projects')
                .send({ id: 'x', name: 'x' })
                .expect(404);
            await ossApp.request
                .post('/api/admin/environments')
                .send({ name: 'x', type: 'test' })
                .expect(404);
        } finally {
            await ossApp.destroy();
            await ossDb.destroy();
        }
    });
});
