import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  createPurchaseRequest,
  executePurchaseRequestAction,
  getPurchaseWorkspace,
} from '../lib/purchase-workflow-service';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_purchase_workflow';
const config: ShopifyCredentialConfig = {
  key: 'bizfurniz', displayName: 'BizFurniz', domain: 'bizfurniz.myshopify.com',
  expectedDomain: 'bizfurniz.myshopify.com', acceptedDomains: ['bizfurniz.myshopify.com'],
  environmentPrefix: 'SHOPIFY_BIZFURNIZ', authMode: 'oauth', credentialRef: 'env:test',
  adminAccessToken: null, clientId: null, clientSecret: null,
};
const shopContext: ShopifyShopContext = {
  id: 'gid://shopify/Shop/9001', name: 'BizFurniz', domain: 'bizfurniz.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders']),
};
const user: UserContext = {
  id: 'auth-creator', email: 'creator@example.invalid', displayName: '创建人', role: 'admin',
  permissions: ROLE_PERMISSIONS.admin, tenantId, tenantName: '采购测试工作区',
};
const buyerUser: UserContext = {
  ...user,
  id: 'auth-buyer',
  email: 'buyer@example.invalid',
  displayName: '采购员',
  role: 'operator',
  permissions: ROLE_PERMISSIONS.operator,
};
const reviewerUser: UserContext = {
  ...user,
  id: 'auth-reviewer',
  email: 'reviewer@example.invalid',
  displayName: '复审员',
};

describe('采购申请闭环', () => {
  let mf: Miniflare;
  let db: D1Database;
  let demandId: string;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await seedMembers(db);
    demandId = await seedMappedDemand(db);
  });

  afterEach(async () => { await mf.dispose(); });

  it('从真实订单需求创建草稿，幂等重放且阻止重复采购', async () => {
    const input = {
      demandIds: [demandId],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
      note: '先采购真实未履约订单',
    };
    const created = await createPurchaseRequest(db, user, input, 'create-request-0001');
    expect(created.replayed).toBe(false);
    expect(created.request).toEqual(expect.objectContaining({
      status: 'draft', lineCount: 1, totalQuantity: 1, needsAttention: false,
      purchaser: expect.objectContaining({ displayName: '采购员' }),
      reviewer: expect.objectContaining({ displayName: '复审员' }),
    }));
    expect(created.request.lines[0]).toEqual(expect.objectContaining({
      purchaseDemandId: demandId, skuCode: 'SERVICE-01', requestedQuantity: 1, active: true,
    }));

    const replay = await createPurchaseRequest(db, user, input, 'create-request-0001');
    expect(replay.replayed).toBe(true);
    expect(replay.request.id).toBe(created.request.id);
    await expect(createPurchaseRequest(db, user, input, 'create-request-0002'))
      .rejects.toMatchObject({ code: 'PURCHASE_DEMAND_ALREADY_ALLOCATED' });

    const audit = await db.prepare(`
      SELECT action, actor_email FROM audit_logs
      WHERE tenant_id = ? AND entity_id = ?
    `).bind(tenantId, created.request.id).all<{ action: string; actor_email: string }>();
    expect(audit.results).toEqual([{ action: 'CREATE_PURCHASE_REQUEST', actor_email: user.email }]);
    expect(JSON.stringify(created.request)).not.toContain(user.email);
  });

  it('草稿可提交和批准，源需求后续变化会保留申请并标记关注', async () => {
    const created = await createPurchaseRequest(db, user, {
      demandIds: [demandId], purchaserMemberId: 'member-buyer', reviewerMemberId: 'member-reviewer',
    }, 'create-request-1001');
    const submitted = await executePurchaseRequestAction(db, buyerUser, created.request.id, {
      action: 'submit', note: '提交复审',
    }, 'submit-request-1001');
    expect(submitted.request.status).toBe('pending_review');
    const approved = await executePurchaseRequestAction(db, reviewerUser, created.request.id, {
      action: 'approve', note: '批准采购',
    }, 'approve-request-1001');
    expect(approved.request).toEqual(expect.objectContaining({
      status: 'approved', reviewNote: '批准采购', needsAttention: false,
    }));

    const replay = await executePurchaseRequestAction(db, reviewerUser, created.request.id, {
      action: 'approve', note: '批准采购',
    }, 'approve-request-1001');
    expect(replay.replayed).toBe(true);

    await db.prepare(`
      UPDATE purchase_demands
      SET source_updated_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).bind('2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z', demandId, tenantId).run();
    const workspace = await getPurchaseWorkspace(db, user);
    expect(workspace.requests[0]).toEqual(expect.objectContaining({
      status: 'approved', needsAttention: true,
    }));
    expect(workspace.requests[0].lines[0].needsAttention).toBe(true);
    expect(workspace.requestSummary).toEqual(expect.objectContaining({ approved: 1, needsAttention: 1 }));
  });

  it('驳回仅释放需求并保留历史，允许重新发起', async () => {
    const first = await createPurchaseRequest(db, user, {
      demandIds: [demandId], purchaserMemberId: 'member-buyer', reviewerMemberId: 'member-reviewer',
    }, 'create-request-2001');
    await executePurchaseRequestAction(db, buyerUser, first.request.id, { action: 'submit' }, 'submit-request-2001');
    const rejected = await executePurchaseRequestAction(db, reviewerUser, first.request.id, {
      action: 'reject', note: '供应安排需要调整',
    }, 'reject-request-2001');
    expect(rejected.request).toEqual(expect.objectContaining({
      status: 'rejected', reviewNote: '供应安排需要调整',
    }));
    expect(rejected.request.lines[0].active).toBe(false);

    const second = await createPurchaseRequest(db, user, {
      demandIds: [demandId], purchaserMemberId: 'member-buyer', reviewerMemberId: 'member-reviewer',
    }, 'create-request-2002');
    expect(second.request.status).toBe('draft');
    const count = await db.prepare('SELECT COUNT(*) AS count FROM purchase_requests WHERE tenant_id = ?')
      .bind(tenantId).first<{ count: number }>();
    expect(Number(count?.count)).toBe(2);
  });

  it('提交前订单需求失效时拒绝继续审批', async () => {
    const created = await createPurchaseRequest(db, user, {
      demandIds: [demandId], purchaserMemberId: 'member-buyer', reviewerMemberId: 'member-reviewer',
    }, 'create-request-3001');
    await db.prepare(`
      UPDATE purchase_demands
      SET status = 'not_required', required_quantity = 0, reason_code = 'cancelled_order', updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).bind('2026-11-02T13:00:00.000Z', demandId, tenantId).run();
    await expect(executePurchaseRequestAction(db, buyerUser, created.request.id, {
      action: 'submit',
    }, 'submit-request-3001')).rejects.toMatchObject({ code: 'PURCHASE_DEMAND_CHANGED' });
    const stored = await db.prepare('SELECT status FROM purchase_requests WHERE id = ?')
      .bind(created.request.id).first<{ status: string }>();
    expect(stored?.status).toBe('draft');
  });

  it('只有分配的负责人可提交，只有分配的复审人可审批', async () => {
    const created = await createPurchaseRequest(db, user, {
      demandIds: [demandId], purchaserMemberId: 'member-buyer', reviewerMemberId: 'member-reviewer',
    }, 'create-request-assignee-0001');
    await expect(executePurchaseRequestAction(db, user, created.request.id, {
      action: 'submit',
    }, 'submit-request-assignee-denied')).rejects.toMatchObject({
      code: 'PURCHASE_PURCHASER_REQUIRED',
    });
    await executePurchaseRequestAction(db, buyerUser, created.request.id, {
      action: 'submit',
    }, 'submit-request-assignee-0001');
    await expect(executePurchaseRequestAction(db, user, created.request.id, {
      action: 'approve',
    }, 'approve-request-assignee-denied')).rejects.toMatchObject({
      code: 'PURCHASE_REVIEWER_REQUIRED',
    });
    const approved = await executePurchaseRequestAction(db, reviewerUser, created.request.id, {
      action: 'approve',
    }, 'approve-request-assignee-0001');
    expect(approved.request.status).toBe('approved');
  });

  it('正式模式强制岗位分离，开发开放模式明确允许同人试运行', async () => {
    const sameAssigneeInput = {
      demandIds: [demandId],
      purchaserMemberId: 'member-reviewer',
      reviewerMemberId: 'member-reviewer',
    };
    await expect(createPurchaseRequest(
      db,
      user,
      sameAssigneeInput,
      'create-request-same-formal',
    )).rejects.toMatchObject({ code: 'PURCHASE_REVIEWER_MUST_DIFFER' });

    const created = await createPurchaseRequest(
      db,
      user,
      sameAssigneeInput,
      'create-request-same-development',
      { developmentOpenAccess: true },
    );
    const submitted = await executePurchaseRequestAction(
      db,
      reviewerUser,
      created.request.id,
      { action: 'submit' },
      'submit-request-same-development',
      { developmentOpenAccess: true },
    );
    expect(submitted.request.status).toBe('pending_review');
    const approved = await executePurchaseRequestAction(
      db,
      reviewerUser,
      created.request.id,
      { action: 'approve' },
      'approve-request-same-development',
      { developmentOpenAccess: true },
    );
    expect(approved.request.status).toBe('approved');
  });
});

async function seedMembers(db: D1Database) {
  const now = '2026-11-02T00:00:00.000Z';
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, '采购测试工作区', now),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-creator', ?, ?, ?, '创建人', 'admin', ?)`)
      .bind(tenantId, user.id, user.email, now),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-buyer', ?, 'auth-buyer', 'buyer@example.invalid', '采购员', 'operator', ?)`)
      .bind(tenantId, now),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-reviewer', ?, 'auth-reviewer', 'reviewer@example.invalid', '复审员', 'admin', ?)`)
      .bind(tenantId, now),
  ]);
}

async function seedMappedDemand(db: D1Database) {
  const repository = new PlatformOrderRepository(db, tenantId);
  const storeId = (await repository.upsertVerifiedShopifyStore(
    config,
    shopContext,
    '2026-11-02T00:00:01.000Z',
  )).id;
  const graph = shopifyOrderFixture({
    updatedAt: '2026-11-02T01:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    refunds: [],
    fulfillments: [],
  });
  graph.lines[1].rawSku = 'SERVICE-01';
  graph.lines[1].normalizedSku = 'SERVICE-01';
  await repository.upsertOrderGraph({
    storeId, graph, apiVersion: '2026-07', runId: null,
    fetchedAt: '2026-11-02T01:00:01.000Z',
  });
  await db.prepare(`
    INSERT INTO skus (id, tenant_id, code, name, active, created_at)
    VALUES ('sku-service', ?, 'SERVICE-01', '服务商品', 1, ?)
  `).bind(tenantId, '2026-11-02T01:00:02.000Z').run();
  await db.prepare(`
    UPDATE platform_sku_mappings
    SET sku_id = 'sku-service', status = 'mapped', mapping_source = 'workflow_test', updated_at = ?
    WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = 'SERVICE-01'
  `).bind('2026-11-02T01:00:02.000Z', tenantId, storeId).run();
  await repository.upsertOrderGraph({
    storeId, graph, apiVersion: '2026-07', runId: null,
    fetchedAt: '2026-11-02T01:00:03.000Z',
  });
  const demand = await db.prepare(`
    SELECT id FROM purchase_demands
    WHERE tenant_id = ? AND raw_sku = 'SERVICE-01' AND status = 'open'
    LIMIT 1
  `).bind(tenantId).first<{ id: string }>();
  if (!demand) throw new Error('workflow test demand missing');
  return demand.id;
}

async function applyMigrations(db: D1Database) {
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
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
