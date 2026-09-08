// Loads ./.env when present; existing process env always wins (dotenv never overrides).
import 'dotenv/config';
import { start } from './lib/server-impl.js';
import { createConfig } from './lib/create-config.js';
import { LogLevel } from './lib/logger.js';
import { ApiTokenType } from './lib/types/model.js';
import { larkAuthenticationFromEnv } from './lib/middleware/lark-authentication.js';
import {
    multiProjectFlags,
    multiProjectFromEnv,
} from './lib/util/multi-project-from-env.js';

// local server configuraion for development purposes.
process.nextTick(async () => {
    try {
        await start(
            createConfig({
                // UNLEASH_MULTI_PROJECT=true lifts the OSS single-project gate.
                ...multiProjectFromEnv(),
                db: process.env.DATABASE_URL
                    ? undefined
                    : {
                          user: 'unleash_user',
                          password: 'password',
                          host: 'localhost',
                          port: 5432,
                          database:
                              process.env.UNLEASH_DATABASE_NAME || 'unleash',
                          schema: process.env.UNLEASH_DATABASE_SCHEMA,
                          ssl: false,
                          applicationName: 'unleash',
                      },
                server: {
                    enableRequestLogger: true,
                    baseUriPath: '',
                    // keepAliveTimeout: 1,
                    gracefulShutdownEnable: true,
                    // cdnPrefix: 'https://cdn.getunleash.io/unleash/v4.4.1',
                    enableHeapSnapshotEnpoint: true,
                },
                logLevel: LogLevel.debug,
                secureHeaders: false,
                versionCheck: {
                    enable: false,
                },
                experimental: {
                    // externalResolver: unleash,
                    flags: {
                        ...multiProjectFlags(),
                        anonymiseEventLog: false,
                        responseTimeWithAppNameKillSwitch: false,
                        outdatedSdksBanner: true,
                        disableShowContextFieldSelectionValues: false,
                        feedbackPosting: true,
                        manyStrategiesPagination: true,
                        enableLegacyVariants: false,
                        extendedMetrics: true,
                        webhookDomainLogging: true,
                        showUserDeviceCount: true,
                        deltaApi: true,
                        uniqueSdkTracking: true,
                        strictSchemaValidation: true,
                        disableImpactMetrics: false,
                        regexConstraintOperator: true,
                        semverGteConstraintOperators: true,
                        userTokenWithClientApiLoggingKillSwitch: false,
                        allowDeprecatedApiTokenMiddleware: false,
                        newProfileDropdown: true,
                        learningLab: true,
                        floatingOnboardingChecklist: true,
                        serviceNowIntegration: true,
                        onboardingIntroTour: true,
                        topLabelInputs: true,
                        recordSdkFlavorMetrics: true,
                        semverBuildMetadata: true,
                        slackIntegrationProjectLevel: true,
                        flagStatusTooltips: true,
                        simplerStrategySetup: true,
                        totalUsageMetrics: true,
                    },
                },
                authentication: {
                    // Opt in to Lark login by exporting LARK_AUTH_* (see LARK_AUTH.md).
                    ...larkAuthenticationFromEnv(),
                    initApiTokens: [
                        {
                            environment: '*',
                            projects: ['*'],
                            secret: '*:*.964a287e1b728cb5f4f3e0120df92cb5',
                            type: ApiTokenType.ADMIN,
                            tokenName: 'some-user',
                        },
                    ],
                },
                prometheusImpactMetricsApi: 'http://localhost:9090',
                /* can be tweaked to control configuration caching for /api/client/features
                clientFeatureCaching: {
                    enabled: true,
                    maxAge: 4000,
                },
                */
            }),
        );
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            // eslint-disable-next-line no-console
            console.warn('Port in use. You might want to reload once more.');
        } else {
            // eslint-disable-next-line no-console
            console.error(error);
            process.exit();
        }
    }
}, 0);
