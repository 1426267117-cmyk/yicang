import { env } from 'cloudflare:workers';
import { HttpError, requestContext, requirePermission } from '../../../../lib/db';
import { nineStoreOrderSnapshotSchema, nineStoreSnapshotMaxBytes } from '../../../../lib/nine-store-orders-contract';
import { storeNineStoreOrderSnapshot } from '../../../../lib/nine-store-orders-service';
import { feishuPreviewError, feishuPreviewHeaders, readFeishuPreviewJson, requireFeishuImportOrigin } from '../../../../lib/feishu-procurement-preview-http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'members:manage');
    requireFeishuImportOrigin(request, env as unknown as Record<string, unknown>);
    const parsed = nineStoreOrderSnapshotSchema.safeParse(await readFeishuPreviewJson(request, nineStoreSnapshotMaxBytes));
    if (!parsed.success) throw new HttpError(400, '期初订单文件格式、店铺范围或批次统计无效', 'NINE_STORE_SNAPSHOT_INVALID');
    const result = await storeNineStoreOrderSnapshot(db, user.tenantId, parsed.data, new Date(), user);
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers: feishuPreviewHeaders });
  } catch (error) {
    return feishuPreviewError(error);
  }
}
