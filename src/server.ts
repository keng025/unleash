// Loads ./.env when present; existing process env always wins (dotenv never overrides).
import 'dotenv/config';
import { start } from './lib/server-impl.js';
import { larkAuthenticationFromEnv } from './lib/middleware/lark-authentication.js';
import { multiProjectFromEnv } from './lib/util/multi-project-from-env.js';

// Lark login: LARK_AUTH_* env vars (see LARK_AUTH.md).
// Multiple projects / environments: UNLEASH_MULTI_PROJECT=true.
const authentication = larkAuthenticationFromEnv();

try {
    await start({
        ...multiProjectFromEnv(),
        ...(authentication ? { authentication } : {}),
    });
} catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit();
}
