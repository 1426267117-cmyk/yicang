import { env, waitUntil } from 'cloudflare:workers';
import { requestContext } from '../../../../../lib/db';
import {
  evaluateMukuFreshness,
  refreshMukuIfDue,
} from '../../../../../lib/muku-freshness-service';
import { getMukuStatus } from '../../../../../lib/muku-sync-service';
import {
  createMukuClient,
  hasMukuConfiguration,
  mukuErrorResponse,
  NO_STORE_HEADERS,
} from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const configured = hasMukuConfiguration();
    const [status, freshness] = await Promise.all([
      getMukuStatus(db, user),
      evaluateMukuFreshness(db, user.tenantId, { runtimeEnv }),
    ]);
    const refreshTriggered = configured && freshness.refreshDue;
    if (refreshTriggered) {
      waitUntil(refreshMukuIfDue({
        db,
        tenantId: user.tenantId,
        tenantName: user.tenantName,
        client: createMukuClient(),
        runtimeEnv,
      }).catch((error) => {
        console.error('muku_background_refresh_failed', JSON.stringify({
          tenantId: user.tenantId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }));
      }));
    }
    return Response.json({
      ...status,
      configured,
      freshness,
      autoRefresh: {
        mode: 'stale-while-revalidate',
        refreshTriggered,
        internalJobEndpoint: '/api/connectors/muku/refresh',
        externalScheduleConfigured: false,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
