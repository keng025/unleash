import type { Response } from 'express';
import Controller from '../../routes/controller.js';
import type { IAuthRequest } from '../../routes/unleash-types.js';
import { nameType } from '../../routes/util.js';
import type { IUnleashServices } from '../../services/index.js';
import {
    ADMIN,
    CREATE_PROJECT,
    DELETE_PROJECT,
    NONE,
    UPDATE_PROJECT,
    type IEnvironmentCreate,
    type IUnleashConfig,
    type IUnleashStores,
    serializeDates,
} from '../../types/index.js';
import type { IEnvironmentStore } from '../project-environments/environment-store-type.js';
import type { IProjectStore } from '../project/project-store-type.js';
import type ProjectService from '../project/project-service.js';
import BadDataError from '../../error/bad-data-error.js';
import NameExistsError from '../../error/name-exists-error.js';
import NotFoundError from '../../error/notfound-error.js';

/**
 * Project and environment write routes for UNLEASH_MULTI_PROJECT mode.
 *
 * Upstream OSS ships the services and stores for creating projects and
 * environments but mounts the HTTP routes only from the enterprise package.
 * This controller exposes the same paths the bundled frontend calls
 * (`useProjectApi`, `useEnvironmentApi`) so the "New project" and
 * "New environment" dialogs work without enterprise.
 *
 * Mounted only when the server runs in the pro-shaped multi-project
 * configuration (see multiProjectFromEnv); plain OSS and enterprise
 * deployments are untouched.
 */
export class MultiProjectController extends Controller {
    private projectService: ProjectService;
    private projectStore: IProjectStore;
    private environmentStore: IEnvironmentStore;

    constructor(
        config: IUnleashConfig,
        { projectService }: Pick<IUnleashServices, 'projectService'>,
        {
            projectStore,
            environmentStore,
        }: Pick<IUnleashStores, 'projectStore' | 'environmentStore'>,
    ) {
        super(config);
        this.projectService = projectService;
        this.projectStore = projectStore;
        this.environmentStore = environmentStore;

        // Upstream OSS GET /projects hard-codes `{ id: 'default' }`; this
        // route is mounted ahead of it and lists every project instead.
        this.route({
            method: 'get',
            path: '/projects',
            handler: this.getProjects,
            permission: NONE,
        });
        this.route({
            method: 'post',
            path: '/projects',
            handler: this.createProject,
            permission: CREATE_PROJECT,
        });
        this.route({
            method: 'post',
            path: '/projects/validate',
            handler: this.validateProjectId,
            permission: CREATE_PROJECT,
        });
        this.route({
            method: 'put',
            path: '/projects/:projectId',
            handler: this.updateProject,
            permission: UPDATE_PROJECT,
        });
        this.route({
            method: 'delete',
            path: '/projects/:projectId',
            acceptAnyContentType: true,
            handler: this.deleteProject,
            permission: DELETE_PROJECT,
        });

        this.route({
            method: 'post',
            path: '/environments',
            handler: this.createEnvironment,
            permission: ADMIN,
        });
        this.route({
            method: 'post',
            path: '/environments/validate',
            handler: this.validateEnvironmentName,
            permission: ADMIN,
        });
        this.route({
            method: 'put',
            path: '/environments/update/:name',
            handler: this.updateEnvironment,
            permission: ADMIN,
        });
        this.route({
            method: 'delete',
            path: '/environments/:name',
            acceptAnyContentType: true,
            handler: this.deleteEnvironment,
            permission: ADMIN,
        });
    }

    async getProjects(req: IAuthRequest, res: Response): Promise<void> {
        const projects = await this.projectService.getProjects({}, req.user.id);
        const withOwners =
            await this.projectService.addOwnersToProjects(projects);
        res.status(200).json({
            version: 1,
            projects: serializeDates(withOwners),
        });
    }

    async createProject(req: IAuthRequest, res: Response): Promise<void> {
        const created = await this.projectService.createProject(
            req.body,
            req.user,
            req.audit,
        );
        res.status(201).json(serializeDates(created));
    }

    async validateProjectId(
        req: IAuthRequest<unknown, unknown, { id?: string }>,
        res: Response,
    ): Promise<void> {
        const { error } = nameType.validate(req.body.id);
        if (error) {
            throw new BadDataError(error.message);
        }
        if (await this.projectStore.hasProject(req.body.id as string)) {
            throw new NameExistsError('A project with this id already exists.');
        }
        res.status(200).end();
    }

    async updateProject(
        req: IAuthRequest<{ projectId: string }>,
        res: Response,
    ): Promise<void> {
        await this.projectService.updateProject(
            { ...req.body, id: req.params.projectId },
            req.audit,
        );
        res.status(200).end();
    }

    async deleteProject(
        req: IAuthRequest<{ projectId: string }>,
        res: Response,
    ): Promise<void> {
        await this.projectService.deleteProject(
            req.params.projectId,
            req.user,
            req.audit,
        );
        res.status(200).end();
    }

    async createEnvironment(
        req: IAuthRequest<unknown, unknown, IEnvironmentCreate>,
        res: Response,
    ): Promise<void> {
        const { name, type, sortOrder, enabled = true } = req.body;
        await this.assertEnvironmentNameFree(name);
        if (!type) {
            throw new BadDataError('Environment type is required.');
        }
        const created = await this.environmentStore.create({
            name,
            type,
            sortOrder,
            enabled,
        });
        res.status(201).json(serializeDates(created));
    }

    async validateEnvironmentName(
        req: IAuthRequest<unknown, unknown, { name?: string }>,
        res: Response,
    ): Promise<void> {
        await this.assertEnvironmentNameFree(req.body.name);
        res.status(200).end();
    }

    async updateEnvironment(
        req: IAuthRequest<
            { name: string },
            unknown,
            { type?: string; sortOrder?: number }
        >,
        res: Response,
    ): Promise<void> {
        const { name } = req.params;
        const { type, sortOrder } = req.body;
        const existing = await this.environmentStore.get(name);
        if (!existing) {
            throw new NotFoundError(`Environment ${name} not found`);
        }
        if (type && type !== existing.type) {
            await this.environmentStore.update(
                {
                    type,
                    protected: existing.protected,
                    requiredApprovals: existing.requiredApprovals,
                },
                name,
            );
        }
        if (sortOrder !== undefined) {
            await this.environmentStore.updateSortOrder(name, sortOrder);
        }
        res.status(200).json(
            serializeDates(await this.environmentStore.get(name)),
        );
    }

    async deleteEnvironment(
        req: IAuthRequest<{ name: string }>,
        res: Response,
    ): Promise<void> {
        await this.environmentStore.delete(req.params.name);
        res.status(200).end();
    }

    private async assertEnvironmentNameFree(name?: string): Promise<void> {
        const { error } = nameType.validate(name);
        if (error) {
            throw new BadDataError(error.message);
        }
        if (await this.environmentStore.exists(name as string)) {
            throw new NameExistsError(
                'An environment with this name already exists.',
            );
        }
    }
}
