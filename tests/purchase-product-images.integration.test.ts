import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { GET } from '../app/api/purchase/product-images/[id]/route';
import { POST } from '../app/api/purchase/product-images/route';
import { openSqliteD1, type SqliteD1 } from '../lib/aws/sqlite-d1';
import * as databaseRuntime from '../lib/db';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { purchaseProductDetailsSchema } from '../lib/contracts';
import { maxPurchaseProductImageBytes, purchaseProductImagePath } from '../lib/purchase-product-details';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAuwB9Y9lrvwAAAAASUVORK5CYII=', 'base64'));
const user: UserContext = {
  id: 'purchaser', email: 'purchaser@example.invalid', displayName: '买手', role: 'operator',
  permissions: ROLE_PERMISSIONS.operator, tenantId: 'tenant-a', tenantName: '采购甲',
};

describe('采购产品图片', () => {
  let sqlite: SqliteD1;
  let caller: UserContext;

  beforeEach(async () => {
    sqlite = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle', import.meta.url)));
    await sqlite.db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('tenant-a', '甲', '2026-11-25'), ('tenant-b', '乙', '2026-11-25')").run();
    caller = user;
    vi.spyOn(databaseRuntime, 'requestContext').mockImplementation(async () => ({ db: sqlite.db, user: caller }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite?.close();
  });

  function upload(content: BodyInit, contentType: string) {
    return POST(new Request(`http://localhost${purchaseProductImagePath}`, {
      method: 'POST', headers: { 'Content-Type': contentType }, body: content,
    }));
  }

  function readImage(imageUrl: string) {
    return GET(new Request(`http://localhost${imageUrl}`), {
      params: Promise.resolve({ id: imageUrl.slice(purchaseProductImagePath.length) }),
    });
  }

  it('上传后原样读取，同公司重复上传去重，其他公司无法读取', async () => {
    const first = await upload(png, 'image/png');
    expect(first.status).toBe(201);
    const { imageUrl } = await first.json() as { imageUrl: string };
    expect(purchaseProductDetailsSchema.safeParse({ imageUrl }).success).toBe(true);
    const replay = await upload(png, 'image/png');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, imageUrl });
    expect(await sqlite.db.prepare('SELECT COUNT(*) AS count FROM purchase_product_images').first('count')).toBe(1);

    caller = { ...user, role: 'viewer', permissions: ROLE_PERMISSIONS.viewer };
    const read = await readImage(imageUrl);
    expect(read.status).toBe(200);
    expect(read.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(png);
    caller = { ...caller, tenantId: 'tenant-b' };
    expect((await readImage(imageUrl)).status).toBe(404);
    expect((await upload(png, 'image/png')).status).toBe(403);
  });

  it('拒绝不支持的格式、伪装文件、超限内容及非采购站内地址', async () => {
    expect((await upload('<svg></svg>', 'image/svg+xml')).status).toBe(415);
    expect((await upload('<script />', 'image/png')).status).toBe(415);
    expect((await upload(new Uint8Array(maxPurchaseProductImageBytes + 1), 'image/png')).status).toBe(413);
    expect(purchaseProductDetailsSchema.safeParse({ imageUrl: '/api/private/credentials' }).success).toBe(false);
    expect(await sqlite.db.prepare('SELECT COUNT(*) AS count FROM purchase_product_images').first('count')).toBe(0);
  });
});
