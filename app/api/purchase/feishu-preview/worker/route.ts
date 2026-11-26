import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ensureDatabase } from '../../../../../db/initialize';
import { HttpError } from '../../../../../lib/db';
import {
  FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES, feishuProcurementPreviewSchema,
} from '../../../../../lib/feishu-procurement-preview-contract';
import {
  feishuPreviewError, feishuPreviewHeaders, readFeishuPreviewJson,
} from '../../../../../lib/feishu-procurement-preview-http';
import {
  FEISHU_SYNC_ERROR_CODES, claimFeishuSync, completeFeishuSync, failFeishuSync, feishuSyncWorkerToken,
} from '../../../../../lib/feishu-procurement-sync';
import { InternalJobAuthError, requireInternalJobToken } from '../../../../../lib/internal-job-auth';

export const dynamic = 'force-dynamic';

const workerAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('claim') }),
  z.strictObject({
    action: z.literal('complete'), id: z.uuid(), snapshot: feishuProcurementPreviewSchema,
  }),
  z.strictObject({
    action: z.literal('fail'), id: z.uuid(), error: z.enum(FEISHU_SYNC_ERROR_CODES),
  }),
]);

export async function POST(request: Request) {
  try {
    const runtime = env as unknown as Record<string, unknown> & { DB?: D1Database };
    const token = feishuSyncWorkerToken(request, runtime);
    if (!token || !runtime.DB) {
      throw new HttpError(503, '飞书同步尚未启用', 'FEISHU_SYNC_DISABLED');
    }
    requireInternalJobToken(request.headers, { ERP_INTERNAL_JOB_TOKEN: token });
    const parsed = workerAction.safeParse(await readFeishuPreviewJson(request, FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES + 512));
    if (!parsed.success) {
      throw new HttpError(400, '同步任务参数或快照无效', 'INVALID_FEISHU_SYNC_REQUEST');
    }
    const db = runtime.DB;
    await ensureDatabase(db);
    const operation = parsed.data;
    if (operation.action === 'claim') {
      return workerResponse({ claim: await claimFeishuSync(db) });
    }
    if (operation.action === 'fail') {
      if (!await failFeishuSync(db, operation.id, operation.error)) throw expiredClaim();
      return workerResponse({});
    }
    const result = await completeFeishuSync(db, operation.id, operation.snapshot);
    if (!result) throw expiredClaim();
    return workerResponse(result);
  } catch (error) {
    return feishuPreviewError(error instanceof InternalJobAuthError
      ? new HttpError(error.status, error.message, error.code)
      : error);
  }
}

function workerResponse(body: Record<string, unknown>) {
  return Response.json({ ok: true, ...body }, { headers: feishuPreviewHeaders });
}

function expiredClaim() {
  return new HttpError(409, '同步任务已结束或租约过期', 'FEISHU_SYNC_LEASE_EXPIRED');
}
