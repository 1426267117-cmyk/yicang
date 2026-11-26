import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../../../../db/initialize';
import { HttpError } from '../../../../../../lib/db';
import { feishuPreviewError, feishuPreviewHeaders, readFeishuPreviewJson } from '../../../../../../lib/feishu-procurement-preview-http';
import { FEISHU_SYNC_TENANT_ID, feishuSyncWorkerToken } from '../../../../../../lib/feishu-procurement-sync';
import { InternalJobAuthError, requireInternalJobToken } from '../../../../../../lib/internal-job-auth';
import { nineStoreOrderSnapshotSchema, nineStoreSnapshotMaxBytes } from '../../../../../../lib/nine-store-orders-contract';
import { storeNineStoreOrderSnapshot } from '../../../../../../lib/nine-store-orders-service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const runtime = env as unknown as Record<string, unknown> & { DB?: D1Database };
    const token = feishuSyncWorkerToken(request, runtime);
    if (!token || !runtime.DB || runtime.ERP_FEISHU_ORDERS_SYNC_ENABLED !== 'true') {
      throw new HttpError(503, '九店订单同步尚未启用', 'NINE_STORE_SYNC_DISABLED');
    }
    requireInternalJobToken(request.headers, { ERP_INTERNAL_JOB_TOKEN: token });
    const input = nineStoreOrderSnapshotSchema.safeParse(await readFeishuPreviewJson(request, nineStoreSnapshotMaxBytes));
    if (!input.success) throw new HttpError(400, '订单快照或范围校验失败', 'NINE_STORE_SNAPSHOT_INVALID');
    await ensureDatabase(runtime.DB);
    const result = await storeNineStoreOrderSnapshot(runtime.DB, FEISHU_SYNC_TENANT_ID, input.data);
    return Response.json({ ok: true, ...result }, { headers: feishuPreviewHeaders, status: result.replayed ? 200 : 201 });
  } catch (error) {
    return feishuPreviewError(error instanceof InternalJobAuthError ? new HttpError(error.status, error.message, error.code) : error);
  }
}
