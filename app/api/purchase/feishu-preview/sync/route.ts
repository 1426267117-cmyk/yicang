import { env } from 'cloudflare:workers';
import { HttpError, requestContext, requirePermission } from '../../../../../lib/db';
import { feishuPreviewError, feishuPreviewHeaders } from '../../../../../lib/feishu-procurement-preview-http';
import {
  FEISHU_SYNC_TENANT_ID, feishuSyncBrowserOrigin, queueFeishuSync,
} from '../../../../../lib/feishu-procurement-sync';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'members:manage');
    if (user.tenantId !== FEISHU_SYNC_TENANT_ID) {
      throw new HttpError(403, '只有工作区管理员可以触发同步', 'PERMISSION_DENIED');
    }
    const allowedOrigin = feishuSyncBrowserOrigin(request, env as unknown as Record<string, unknown>);
    if (!allowedOrigin) {
      throw new HttpError(503, '飞书同步尚未启用', 'FEISHU_SYNC_DISABLED');
    }
    if (request.headers.get('Origin') !== allowedOrigin) {
      throw new HttpError(403, '请求来源与易仓站点不一致', 'FEISHU_SYNC_ORIGIN_MISMATCH');
    }
    if (await hasBody(request)) {
      throw new HttpError(400, '触发同步无需提交参数', 'INVALID_FEISHU_SYNC_REQUEST');
    }
    if (!await queueFeishuSync(db)) {
      throw new HttpError(409, '已有同步请求在等待或运行', 'FEISHU_SYNC_BUSY');
    }
    return Response.json({ ok: true }, { status: 202, headers: feishuPreviewHeaders });
  } catch (error) {
    return feishuPreviewError(error);
  }
}

async function hasBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) {
        await reader.cancel().catch(() => undefined);
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
