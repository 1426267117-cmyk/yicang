import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  getPurchaseRequestAssignment,
  reassignPurchaseRequest,
} from '../lib/purchase-assignment-service';
import { executePurchaseOrderAction } from '../lib/purchase-order-service';

const tenantId = 'tenant-assignment';
const otherTenantId = 'tenant-assignment-other';
const admin: UserContext = {
  id: 'auth-admin',
  email: 'admin@example.invalid',
  displayName: '采购管理员',
  role: 'admin',
  permissions: ROLE_PERMISSIONS.admin,
  tenantId,
  tenantName: '采购工作区',
};

describe('采购申请受控重新指派', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await createSchema(db);
    await seed(db);
  });

  afterEach(async () => { await mf.dispose(); });

  it('管理员可追加审计地移交活跃申请和其采购单控制权，幂等重试不重复', async () => {
    const input = {
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '原负责人休假，交接给当班采购',
      expectedVersion: 3,
    };
    const changed = await reassignPurchaseRequest(
      db,
      admin,
      'request-active',
      input,
      'assignment-transfer-0001',
    );
    expect(changed).toMatchObject({
      replayed: false,
      assignment: {
        version: 4,
        purchaser: { id: 'member-buyer-b', displayName: '采购员乙' },
        reviewer: { id: 'member-reviewer-b', displayName: '复审人乙' },
      },
    });

    const purchaseOrderOwner = await db.prepare(`
      SELECT request.purchaser_member_id
      FROM purchase_orders purchase_order
      JOIN purchase_requests request
        ON request.id = purchase_order.purchase_request_id
        AND request.tenant_id = purchase_order.tenant_id
      WHERE purchase_order.tenant_id = ? AND purchase_order.id = 'order-active'
    `).bind(tenantId).first<{ purchaser_member_id: string }>();
    expect(purchaseOrderOwner?.purchaser_member_id).toBe('member-buyer-b');

    const replay = await reassignPurchaseRequest(
      db,
      admin,
      'request-active',
      input,
      'assignment-transfer-0001',
    );
    expect(replay.replayed).toBe(true);
    expect(replay.assignment.version).toBe(4);

    const audit = await db.prepare(`
      SELECT actor_email, action, before_json, after_json
      FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ?
    `).bind(tenantId, 'assignment-transfer-0001').first<{
      actor_email: string;
      action: string;
      before_json: string;
      after_json: string;
    }>();
    expect(audit?.actor_email).toBe(admin.email);
    expect(audit?.action).toBe('REASSIGN_PURCHASE_REQUEST');
    expect(JSON.parse(audit!.before_json)).toEqual({
      purchaserMemberId: 'member-buyer-a',
      reviewerMemberId: 'member-reviewer-a',
      version: 3,
    });
    expect(JSON.parse(audit!.after_json)).toEqual(expect.objectContaining({
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '原负责人休假，交接给当班采购',
      version: 4,
    }));
    expect(await auditCount(db)).toBe(1);
  });

  it('正式模式交接后旧负责人失去活跃采购单权限，新负责人可继续', async () => {
    const fullMf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    try {
      const fullDb = await fullMf.getD1Database('DB');
      await applyPurchaseMigrations(fullDb);
      await seedFullPurchaseControl(fullDb);
      await reassignPurchaseRequest(fullDb, admin, 'request-active', {
        purchaserMemberId: 'member-buyer-b',
        reviewerMemberId: 'member-reviewer-b',
        reason: '原负责人离岗，由采购员乙接续',
        expectedVersion: 3,
      }, 'assignment-live-order-control');

      const oldBuyer = purchaseActor('auth-buyer-a', 'buyer-a@example.invalid', '旧采购负责人');
      const newBuyer = purchaseActor('auth-buyer-b', 'buyer-b@example.invalid', '新采购负责人');
      await expect(executePurchaseOrderAction(fullDb, oldBuyer, 'order-active', {
        action: 'cancel', note: '旧负责人不应再能操作',
      }, 'assignment-old-buyer-denied')).rejects.toMatchObject({
        code: 'PURCHASE_ORDER_PURCHASER_REQUIRED',
      });

      const continued = await executePurchaseOrderAction(fullDb, newBuyer, 'order-active', {
        action: 'cancel', note: '新负责人接续处理供应商取消',
      }, 'assignment-new-buyer-continues');
      expect(continued.purchaseOrder.status).toBe('cancelled');
    } finally {
      await fullMf.dispose();
    }
  });

  it('正式模式拒绝同人复审，开发开放模式可交接给同一管理员', async () => {
    await expect(reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-reviewer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '开发模式临时联调',
      expectedVersion: 3,
    }, 'assignment-same-formal')).rejects.toMatchObject({
      code: 'PURCHASE_REVIEWER_MUST_DIFFER',
    });

    const changed = await reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-reviewer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '开发模式临时联调',
      expectedVersion: 3,
    }, 'assignment-same-development', { developmentOpenAccess: true });
    expect(changed.assignment).toMatchObject({
      purchaser: { id: 'member-reviewer-b' },
      reviewer: { id: 'member-reviewer-b' },
    });
  });

  it('拒绝无权限、非法角色、跨租户成员、终态申请和并发旧版本', async () => {
    const viewer: UserContext = {
      ...admin,
      id: 'auth-viewer',
      email: 'viewer@example.invalid',
      role: 'viewer',
      permissions: ROLE_PERMISSIONS.viewer,
    };
    await expect(reassignPurchaseRequest(db, viewer, 'request-active', {
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '无权操作',
      expectedVersion: 3,
    }, 'assignment-viewer-denied')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-viewer',
      reviewerMemberId: 'member-reviewer-b',
      reason: '错误角色测试',
      expectedVersion: 3,
    }, 'assignment-bad-buyer')).rejects.toMatchObject({
      code: 'PURCHASE_PURCHASER_PERMISSION_REQUIRED',
    });
    await expect(reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-buyer-b',
      reason: '错误角色测试',
      expectedVersion: 3,
    }, 'assignment-bad-reviewer')).rejects.toMatchObject({
      code: 'PURCHASE_REVIEWER_PERMISSION_REQUIRED',
    });
    await expect(reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-other-buyer',
      reviewerMemberId: 'member-reviewer-b',
      reason: '跨工作区测试',
      expectedVersion: 3,
    }, 'assignment-cross-tenant')).rejects.toMatchObject({
      code: 'PURCHASE_PURCHASER_PERMISSION_REQUIRED',
    });
    await expect(reassignPurchaseRequest(db, admin, 'request-terminal', {
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '终态不允许交接',
      expectedVersion: 1,
    }, 'assignment-terminal')).rejects.toMatchObject({ code: 'PURCHASE_ASSIGNMENT_TERMINAL' });
    await expect(reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '旧页面并发测试',
      expectedVersion: 2,
    }, 'assignment-old-version')).rejects.toMatchObject({
      code: 'PURCHASE_ASSIGNMENT_VERSION_CONFLICT',
    });

    expect((await getPurchaseRequestAssignment(db, tenantId, 'request-active')).version).toBe(3);
    expect(await auditCount(db)).toBe(0);
  });

  it('同一幂等键不能改作不同交接参数', async () => {
    await reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-buyer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '交接一次',
      expectedVersion: 3,
    }, 'assignment-conflict-key');
    await expect(reassignPurchaseRequest(db, admin, 'request-active', {
      purchaserMemberId: 'member-reviewer-b',
      reviewerMemberId: 'member-reviewer-b',
      reason: '改作其他交接',
      expectedVersion: 3,
    }, 'assignment-conflict-key', { developmentOpenAccess: true })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await auditCount(db)).toBe(1);
  });
});

async function createSchema(db: D1Database) {
  await db.prepare(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, auth_user_id TEXT NOT NULL,
      email TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE purchase_requests (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, request_no TEXT NOT NULL,
      status TEXT NOT NULL, purchaser_member_id TEXT NOT NULL, reviewer_member_id TEXT NOT NULL,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE purchase_orders (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, purchase_request_id TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      actor_email TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, request_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE UNIQUE INDEX uq_audit_tenant_idempotency
    ON audit_logs (tenant_id, idempotency_key)
  `).run();
}

async function seed(db: D1Database) {
  await db.batch([
    member(db, 'member-admin', tenantId, 'auth-admin', '采购管理员', 'admin'),
    member(db, 'member-buyer-a', tenantId, 'auth-buyer-a', '采购员甲', 'operator'),
    member(db, 'member-buyer-b', tenantId, 'auth-buyer-b', '采购员乙', 'operator'),
    member(db, 'member-reviewer-a', tenantId, 'auth-reviewer-a', '复审人甲', 'admin'),
    member(db, 'member-reviewer-b', tenantId, 'auth-reviewer-b', '复审人乙', 'admin'),
    member(db, 'member-viewer', tenantId, 'auth-viewer', '只读成员', 'viewer'),
    member(db, 'member-other-buyer', otherTenantId, 'auth-other', '其他工作区采购', 'operator'),
    db.prepare(`
      INSERT INTO purchase_requests (
        id, tenant_id, request_no, status, purchaser_member_id, reviewer_member_id, version, updated_at
      ) VALUES ('request-active', ?, 'CG-TRANSFER', 'approved',
        'member-buyer-a', 'member-reviewer-a', 3, '2026-11-02T00:00:00.000Z')
    `).bind(tenantId),
    db.prepare(`
      INSERT INTO purchase_requests (
        id, tenant_id, request_no, status, purchaser_member_id, reviewer_member_id, version, updated_at
      ) VALUES ('request-terminal', ?, 'CG-TERMINAL', 'cancelled',
        'member-buyer-a', 'member-reviewer-a', 1, '2026-11-02T00:00:00.000Z')
    `).bind(tenantId),
    db.prepare(`
      INSERT INTO purchase_orders (id, tenant_id, purchase_request_id, status)
      VALUES ('order-active', ?, 'request-active', 'issued')
    `).bind(tenantId),
  ]);
}

function member(
  db: D1Database,
  id: string,
  memberTenantId: string,
  authUserId: string,
  displayName: string,
  role: 'admin' | 'operator' | 'viewer',
) {
  return db.prepare(`
    INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-11-02T00:00:00.000Z')
  `).bind(id, memberTenantId, authUserId, `${authUserId}@example.invalid`, displayName, role);
}

async function auditCount(db: D1Database) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM audit_logs')
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function purchaseActor(id: string, email: string, displayName: string): UserContext {
  return {
    id, email, displayName, role: 'operator', permissions: ROLE_PERMISSIONS.operator,
    tenantId, tenantName: '采购工作区',
  };
}

async function applyPurchaseMigrations(db: D1Database) {
  for (const migration of [
    '../drizzle/0000_wooden_deathstrike.sql',
    '../drizzle/0001_premium_the_stranger.sql',
    '../drizzle/0002_organic_titanium_man.sql',
    '../drizzle/0003_fancy_jane_foster.sql',
    '../drizzle/0004_illegal_black_panther.sql',
    '../drizzle/0005_chilly_obadiah_stane.sql',
    '../drizzle/0006_soft_wither.sql',
    '../drizzle/0007_worried_stone_men.sql',
    '../drizzle/0008_nifty_mimic.sql',
    '../drizzle/0009_shocking_iron_lad.sql',
    '../drizzle/0014_clever_silvermane.sql',
    '../drizzle/0015_true_tigra.sql',
    '../drizzle/0016_brief_doomsday.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

async function seedFullPurchaseControl(db: D1Database) {
  const now = '2026-11-02T00:00:00.000Z';
  await db.prepare(`INSERT INTO tenants (id, name, created_at) VALUES (?, '采购工作区', ?)`)
    .bind(tenantId, now).run();
  await db.batch([
    member(db, 'member-admin', tenantId, 'auth-admin', '采购管理员', 'admin'),
    member(db, 'member-buyer-a', tenantId, 'auth-buyer-a', '采购员甲', 'operator'),
    member(db, 'member-buyer-b', tenantId, 'auth-buyer-b', '采购员乙', 'operator'),
    member(db, 'member-reviewer-a', tenantId, 'auth-reviewer-a', '复审人甲', 'admin'),
    member(db, 'member-reviewer-b', tenantId, 'auth-reviewer-b', '复审人乙', 'admin'),
  ]);
  await db.batch([
    db.prepare(`
      INSERT INTO purchase_requests (
        id, tenant_id, request_no, status, purchaser_member_id, reviewer_member_id,
        created_by_member_id, note, review_note, version, idempotency_key, request_hash,
        last_action_key, submitted_at, reviewed_at, created_at, updated_at
      ) VALUES (
        'request-active', ?, 'CG-TRANSFER', 'approved', 'member-buyer-a',
        'member-reviewer-a', 'member-admin', NULL, NULL, 3, 'request-seed-key',
        'request-seed-hash', 'request-seed-action', ?, ?, ?, ?
      )
    `).bind(tenantId, now, now, now, now),
    db.prepare(`
      INSERT INTO suppliers (
        id, tenant_id, code, name, note, active, version, idempotency_key,
        request_hash, created_by_member_id, created_at, updated_at
      ) VALUES (
        'supplier-active', ?, 'SUP-TRANSFER', '交接测试供应商', NULL, 1, 1,
        'supplier-seed-key', 'supplier-seed-hash', 'member-admin', ?, ?
      )
    `).bind(tenantId, now, now),
  ]);
  await db.prepare(`
    INSERT INTO purchase_orders (
      id, tenant_id, order_no, purchase_request_id, supplier_id, status, currency,
      note, action_note, version, idempotency_key, request_hash, last_action_key,
      created_by_member_id, issued_at, cancelled_at, created_at, updated_at
    ) VALUES (
      'order-active', ?, 'PO-TRANSFER', 'request-active', 'supplier-active', 'draft',
      'CNY', NULL, NULL, 1, 'order-seed-key', 'order-seed-hash', 'order-seed-action',
      'member-buyer-a', NULL, NULL, ?, ?
    )
  `).bind(tenantId, now, now).run();
}
