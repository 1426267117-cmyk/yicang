import { env } from 'cloudflare:workers';
import {
  INSERT_FEISHU_PROCUREMENT_PREVIEW,
  feishuProcurementPreviewInsertValues,
  feishuProcurementPreviewSchema,
} from '../../../../lib/feishu-procurement-preview-contract';
import {
  feishuPreviewError, feishuPreviewHeaders, readFeishuPreviewJson, requireFeishuImportOrigin,
} from '../../../../lib/feishu-procurement-preview-http';
import {
  FEISHU_SYNC_TENANT_ID, feishuSyncBrowserOrigin, getFeishuSyncStatus,
} from '../../../../lib/feishu-procurement-sync';
import { HttpError, requestContext, requirePermission } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'purchase:read');
    const stored = await db.prepare(`
      SELECT payload_json, imported_at FROM feishu_procurement_previews
      WHERE tenant_id = ?
      ORDER BY snapshot_date DESC, id DESC
      LIMIT 1
    `).bind(user.tenantId).first<{ payload_json: string; imported_at: string }>();
    const snapshot = stored
      ? feishuProcurementPreviewSchema.parse(JSON.parse(stored.payload_json))
      : null;
    const sync = user.tenantId === FEISHU_SYNC_TENANT_ID
      && feishuSyncBrowserOrigin(request, env as unknown as Record<string, unknown>)
      ? await getFeishuSyncStatus(db, user.permissions.includes('members:manage'), stored?.imported_at ?? null)
      : null;
    return Response.json({ ok: true, snapshot, sync }, { headers: feishuPreviewHeaders });
  } catch (error) {
    return feishuPreviewError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'members:manage');
    requireFeishuImportOrigin(request, env as unknown as Record<string, unknown>);
    const parsed = feishuProcurementPreviewSchema.safeParse(await readFeishuPreviewJson(request));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.');
      throw new HttpError(
        400,
        field ? `采购预览字段格式无效（${field}）` : '采购预览数据格式无效',
        'INVALID_FEISHU_PROCUREMENT_PREVIEW',
      );
    }
    const values = await feishuProcurementPreviewInsertValues(user.tenantId, user.id, parsed.data);
    const { meta } = await db.prepare(INSERT_FEISHU_PROCUREMENT_PREVIEW).bind(...values).run();
    const replayed = Number(meta.changes) === 0;
    return Response.json({ ok: true, snapshotDate: parsed.data.snapshotDate, replayed }, {
      status: replayed ? 200 : 201,
      headers: feishuPreviewHeaders,
    });
  } catch (error) {
    return feishuPreviewError(error);
  }
}
