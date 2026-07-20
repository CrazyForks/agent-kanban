export { TunnelRelay } from "../server/tunnelRelay";

import { createLogger } from "../server/logger";
import { detectStaleMachines } from "../server/machineRepo";
import { backfillMaintainerHttpTriggerConcurrency } from "../server/maintainerTriggerConcurrency";
import { api } from "../server/routes";
import { routePendingTasks } from "../server/runtimeCoordinator";
import { dispatchPendingAmaTasks, reconcileAmaBoundTasks, releaseStaleDispatchClaims } from "../server/taskDispatch";
import { detectAndReleaseStaleAll } from "../server/taskStale";
import type { Env } from "../server/types";

const logger = createLogger("scheduled");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return api.fetch(request, env);
  },

  // Stale-sweep cron — replaces per-request write-on-read detection that used
  // to fire on every GET /api/boards/:id and every machine listing. Fires
  // every minute so the detection window is roughly aligned with
  // MACHINE_STALE_TIMEOUT_MS (60s). Errors in one sweep don't block the other.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        detectStaleMachines(env.DB).catch((err) => logger.warn(`detectStaleMachines failed: ${err}`)),
        backfillMaintainerHttpTriggerConcurrency(env.DB, env).catch((err) => logger.warn(`backfillMaintainerHttpTriggerConcurrency failed: ${err}`)),
        // Task sweeps run sequentially: stale and reconcile sweeps both tear
        // down runtime bindings and must not race each other on the same
        // task, and dispatch last picks up everything they released.
        detectAndReleaseStaleAll(env.DB, env)
          .catch((err) => logger.warn(`detectAndReleaseStaleAll failed: ${err}`))
          .then(() => reconcileAmaBoundTasks(env.DB, env))
          .catch((err) => logger.warn(`reconcileAmaBoundTasks failed: ${err}`))
          .then(() => releaseStaleDispatchClaims(env.DB, env))
          .catch((err) => logger.warn(`releaseStaleDispatchClaims failed: ${err}`))
          .then(() => routePendingTasks(env.DB, env))
          .catch((err) => logger.warn(`routePendingTasks failed: ${err}`))
          .then(() => dispatchPendingAmaTasks(env.DB, env))
          .catch((err) => logger.warn(`dispatchPendingAmaTasks failed: ${err}`)),
      ]),
    );
  },
};
