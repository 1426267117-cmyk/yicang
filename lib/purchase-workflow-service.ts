import type {
  CreatePurchaseRequestInput,
  PurchaseRequestActionInput,
} from './contracts';
import {
  HttpError,
  requirePermission,
  type UserContext,
} from './db';
import { getPurchaseDemands } from './purchase-demand-service';
import { getProcurementWorkspaceData } from './purchase-order-service';
import { ROLE_PERMISSIONS, type Role } from './domain';
import type { PurchasePlanningEvidence } from './purchase-planning-service';

export type PurchaseRequestStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'cancelled';

type PurchaseRequestAction = PurchaseRequestActionInput['action'];

type PurchaseRequestRow = {
  id: string;
  request_no: string;
  status: PurchaseRequestStatus;
  purchaser_member_id: string;
  purchaser_name: string;
  purchaser_role: string;
  reviewer_member_id: string;
  reviewer_name: string;
  reviewer_role: string;
  creator_member_id: string;
  creator_name: string;
  creator_role: string;
  note: string | null;
  review_note: string | null;
  version: number;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  line_count: number;
  total_quantity: number;
  needs_attention: number;
};

type PurchaseRequestLineRow = {
  id: string;
  request_id: string;
  purchase_demand_id: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  requested_quantity: number;
  source_required_quantity: number;
  source_updated_at: string;
  active: number;
  current_status: string;
  current_required_quantity: number;
  current_mapped_sku_id: string | null;
  current_source_updated_at: string;
  store_name: string;
  source_order_name: string | null;
  source_order_id: string;
  source_order_line_id: string;
  raw_sku: string | null;
  title: string | null;
};

type CreateDemandRow = {
  id: string;
  status: string;
  mapped_sku_id: string | null;
  required_quantity: number;
  source_updated_at: string;
  active_line_id: string | null;
};

type CurrentRequestRow = {
  id: string;
  status: PurchaseRequestStatus;
  version: number;
  purchaser_member_id: string;
  reviewer_member_id: string;
  planning_audit_json: string | null;
};

export type PurchaseWorkflowOptions = {
  developmentOpenAccess?: boolean;
  now?: Date;
  maxAgeMinutes?: number;
  sourceMaxAgeMinutes?: number;
  runtimeEnv?: Record<string, unknown>;
};

const ACTION_TRANSITIONS: Record<PurchaseRequestAction, {
  from: PurchaseRequestStatus;
  to: PurchaseRequestStatus;
  permission: 'purchase:submit' | 'purchase:review';
  auditAction: string;
}> = {
  submit: {
    from: 'draft', to: 'pending_review', permission: 'purchase:submit',
    auditAction: 'SUBMIT_PURCHASE_REQUEST',
  },
  approve: {
    from: 'pending_review', to: 'approved', permission: 'purchase:review',
    auditAction: 'APPROVE_PURCHASE_REQUEST',
  },
  reject: {
    from: 'pending_review', to: 'rejected', permission: 'purchase:review',
    auditAction: 'REJECT_PURCHASE_REQUEST',
  },
  cancel: {
    from: 'draft', to: 'cancelled', permission: 'purchase:submit',
    auditAction: 'CANCEL_PURCHASE_REQUEST',
  },
  withdraw: {
    from: 'approved', to: 'cancelled', permission: 'purchase:submit',
    auditAction: 'WITHDRAW_PURCHASE_REQUEST',
  },
};

export async function getPurchaseWorkspace(
  db: D1Database,
  user: UserContext,
  options: Pick<PurchaseWorkflowOptions, 'developmentOpenAccess'> = {},
) {
  requirePermission(user, 'purchase:read');
  const demandPayload = await getPurchaseDemands(db, user);
  const [allocations, requestRows, lineRows, members, skuOptions, availability] = await Promise.all([
    db.prepare(`
      SELECT purchase_demand_id, COALESCE(SUM(requested_quantity), 0) AS allocated_quantity
      FROM purchase_request_lines
      WHERE tenant_id = ? AND active = 1
      GROUP BY purchase_demand_id
    `).bind(user.tenantId).all<{ purchase_demand_id: string; allocated_quantity: number }>(),
    db.prepare(`${PURCHASE_REQUEST_SELECT}
      WHERE pr.tenant_id = ?
      GROUP BY pr.id
      ORDER BY pr.created_at DESC
      LIMIT 200
    `).bind(user.tenantId).all<PurchaseRequestRow>(),
    db.prepare(`${PURCHASE_REQUEST_LINE_SELECT}
      WHERE pr.tenant_id = ?
      ORDER BY pr.created_at DESC, line.created_at ASC
      LIMIT 2000
    `).bind(user.tenantId).all<PurchaseRequestLineRow>(),
    db.prepare(`
      SELECT id, auth_user_id, display_name, role
      FROM members
      WHERE tenant_id = ?
      ORDER BY display_name, id
      LIMIT 500
    `).bind(user.tenantId).all<{
      id: string; auth_user_id: string; display_name: string; role: string;
    }>(),
    db.prepare(`
      SELECT id, code, name
      FROM skus
      WHERE tenant_id = ? AND active = 1
      ORDER BY code
      LIMIT 1000
    `).bind(user.tenantId).all<{ id: string; code: string; name: string }>(),
    db.prepare(`
      WITH allocated AS (
        SELECT purchase_demand_id, SUM(requested_quantity) AS quantity
        FROM purchase_request_lines
        WHERE tenant_id = ? AND active = 1
        GROUP BY purchase_demand_id
      )
      SELECT
        COALESCE(SUM(CASE WHEN pd.status = 'open' THEN COALESCE(allocated.quantity, 0) ELSE 0 END), 0)
          AS allocated_quantity,
        COALESCE(SUM(CASE WHEN pd.status = 'open'
          THEN MAX(0, pd.required_quantity - COALESCE(allocated.quantity, 0)) ELSE 0 END), 0)
          AS available_quantity
      FROM purchase_demands pd
      LEFT JOIN allocated ON allocated.purchase_demand_id = pd.id
      WHERE pd.tenant_id = ?
    `).bind(user.tenantId, user.tenantId).first<{
      allocated_quantity: number;
      available_quantity: number;
    }>(),
  ]);

  const allocatedByDemand = new Map(
    allocations.results.map((row) => [row.purchase_demand_id, Number(row.allocated_quantity)]),
  );
  const linesByRequest = new Map<string, ReturnType<typeof mapRequestLine>[]>();
  for (const row of lineRows.results) {
    const list = linesByRequest.get(row.request_id) ?? [];
    list.push(mapRequestLine(row));
    linesByRequest.set(row.request_id, list);
  }
  const requests = requestRows.results.map((row) => mapRequest(row, linesByRequest.get(row.id) ?? []));
  const demandSummary = demandPayload.summary;
  const requestSummary = {
    total: requests.length,
    draft: requests.filter((request) => request.status === 'draft').length,
    pendingReview: requests.filter((request) => request.status === 'pending_review').length,
    approved: requests.filter((request) => request.status === 'approved').length,
    rejected: requests.filter((request) => request.status === 'rejected').length,
    cancelled: requests.filter((request) => request.status === 'cancelled').length,
    needsAttention: requests.filter((request) => request.needsAttention).length,
  };
  const procurement = await getProcurementWorkspaceData(db, user);

  return {
    ok: true as const,
    demands: demandPayload.demands.map((demand) => {
      const allocatedQuantity = allocatedByDemand.get(demand.id) ?? 0;
      return {
        ...demand,
        allocatedQuantity,
        availableQuantity: demand.status === 'open'
          ? Math.max(0, demand.requiredQuantity - allocatedQuantity)
          : 0,
      };
    }),
    summary: {
      ...demandSummary,
      allocatedQuantity: Number(availability?.allocated_quantity ?? 0),
      availableQuantity: Number(availability?.available_quantity ?? 0),
    },
    requestSummary,
    requests,
    members: members.results.map((member) => ({
      id: member.id,
      displayName: member.display_name,
      role: member.role,
    })),
    currentMemberId: members.results.find((member) => member.auth_user_id === user.id)?.id ?? null,
    developmentOpenAccess: options.developmentOpenAccess === true,
    skuOptions: skuOptions.results.map((sku) => ({ id: sku.id, code: sku.code, name: sku.name })),
    ...procurement,
    readOnly: false as const,
  };
}

export async function createPurchaseRequest(
  db: D1Database,
  user: UserContext,
  input: CreatePurchaseRequestInput,
  idempotencyKey: string,
  options: Pick<PurchaseWorkflowOptions, 'developmentOpenAccess'> = {},
) {
  const normalizedInput = {
    ...input,
    demandIds: [...input.demandIds].sort(),
    note: input.note?.trim() || null,
  };
  return createPurchaseRequestWithAllocations(db, user, {
    purchaserMemberId: normalizedInput.purchaserMemberId,
    reviewerMemberId: normalizedInput.reviewerMemberId,
    note: normalizedInput.note,
    allocations: normalizedInput.demandIds.map((demandId) => ({
      demandId,
      requestedQuantity: null,
    })),
    requestHashInput: normalizedInput,
    auditAction: 'CREATE_PURCHASE_REQUEST',
    auditContext: null,
  }, idempotencyKey, options);
}

export type PurchaseRequestAllocationInput = {
  purchaserMemberId: string;
  reviewerMemberId: string;
  note?: string | null;
  allocations: Array<{ demandId: string; requestedQuantity: number }>;
  recommendationVersions: string[];
  planningInputHash: string;
  planningEvidence: PurchasePlanningEvidence;
};

export async function createPurchaseRequestFromAllocations(
  db: D1Database,
  user: UserContext,
  input: PurchaseRequestAllocationInput,
  idempotencyKey: string,
  options: Pick<PurchaseWorkflowOptions, 'developmentOpenAccess'> = {},
) {
  const normalizedInput = {
    purchaserMemberId: input.purchaserMemberId,
    reviewerMemberId: input.reviewerMemberId,
    note: input.note?.trim() || null,
    allocations: [...input.allocations].sort((left, right) => left.demandId.localeCompare(right.demandId)),
    recommendationVersions: [...input.recommendationVersions].sort(),
    planningInputHash: input.planningInputHash,
    planningEvidence: input.planningEvidence,
  };
  return createPurchaseRequestWithAllocations(db, user, {
    ...normalizedInput,
    allocations: normalizedInput.allocations.map((allocation) => ({
      ...allocation,
      requestedQuantity: allocation.requestedQuantity,
    })),
    requestHashInput: normalizedInput,
    auditAction: 'CREATE_PURCHASE_REQUEST_FROM_PLAN',
    auditContext: {
      recommendationVersions: normalizedInput.recommendationVersions,
      planningInputHash: normalizedInput.planningInputHash,
      planningEvidence: normalizedInput.planningEvidence,
    },
  }, idempotencyKey, options);
}

async function createPurchaseRequestWithAllocations(
  db: D1Database,
  user: UserContext,
  input: {
    purchaserMemberId: string;
    reviewerMemberId: string;
    note: string | null;
    allocations: Array<{ demandId: string; requestedQuantity: number | null }>;
    requestHashInput: unknown;
    auditAction: string;
    auditContext: Record<string, unknown> | null;
  },
  idempotencyKey: string,
  options: Pick<PurchaseWorkflowOptions, 'developmentOpenAccess'> = {},
) {
  requirePermission(user, 'purchase:create');
  validateIdempotencyKey(idempotencyKey);
  if (input.allocations.length === 0) {
    throw new HttpError(400, '采购申请至少需要一条需求', 'PURCHASE_REQUEST_EMPTY');
  }
  const demandIds = input.allocations.map((allocation) => allocation.demandId);
  if (new Set(demandIds).size !== demandIds.length) {
    throw new HttpError(400, '采购需求不能重复选择', 'PURCHASE_DEMAND_DUPLICATE');
  }
  const requestHash = await hashPayload(input.requestHashInput);
  const existing = await db.prepare(`
    SELECT id, request_hash
    FROM purchase_requests
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new HttpError(409, '同一幂等键不能用于不同采购申请', 'IDEMPOTENCY_CONFLICT');
    }
    return { request: await getPurchaseRequest(db, user.tenantId, existing.id), replayed: true };
  }

  const createdByMemberId = await resolveActorMemberId(db, user);
  await validateAssignedMembers(
    db,
    user.tenantId,
    input.purchaserMemberId,
    input.reviewerMemberId,
  );
  assertReviewerSeparation(
    input.purchaserMemberId,
    input.reviewerMemberId,
    options.developmentOpenAccess === true,
  );
  const demands = await loadCreateDemands(db, user.tenantId, demandIds);
  validateCreateDemands(demandIds, demands);
  const demandById = new Map(demands.map((demand) => [demand.id, demand]));
  const resolvedAllocations = input.allocations.map((allocation) => {
    const demand = demandById.get(allocation.demandId)!;
    const requestedQuantity = allocation.requestedQuantity ?? Number(demand.required_quantity);
    if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0
      || requestedQuantity > Number(demand.required_quantity)) {
      throw new HttpError(
        409,
        '采购建议分配量已超过当前订单需求，请刷新后重试',
        'PURCHASE_ALLOCATION_INVALID',
      );
    }
    return { demand, requestedQuantity };
  });

  const now = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const requestNo = createPurchaseRequestNumber();
  const auditAfter = JSON.stringify({
    status: 'draft',
    requestNo,
    purchaserMemberId: input.purchaserMemberId,
    reviewerMemberId: input.reviewerMemberId,
    lineCount: demands.length,
    totalQuantity: resolvedAllocations.reduce((sum, allocation) => sum + allocation.requestedQuantity, 0),
    ...(input.auditContext ?? {}),
  });
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO purchase_requests (
        id, tenant_id, request_no, status, purchaser_member_id, reviewer_member_id,
        created_by_member_id, note, review_note, version, idempotency_key, request_hash,
        last_action_key, submitted_at, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, NULL, 1, ?, ?, ?, NULL, NULL, ?, ?)
    `).bind(
      requestId,
      user.tenantId,
      requestNo,
      input.purchaserMemberId,
      input.reviewerMemberId,
      createdByMemberId,
      input.note,
      idempotencyKey,
      requestHash,
      idempotencyKey,
      now,
      now,
    ),
  ];
  for (const { demand, requestedQuantity } of resolvedAllocations) {
    statements.push(db.prepare(`
      INSERT INTO purchase_request_lines (
        id, tenant_id, request_id, purchase_demand_id, sku_id, requested_quantity,
        source_required_quantity, source_updated_at, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      crypto.randomUUID(),
      user.tenantId,
      requestId,
      demand.id,
      demand.mapped_sku_id,
      requestedQuantity,
      demand.required_quantity,
      demand.source_updated_at,
      now,
    ));
  }
  statements.push(auditInsertStatement(db, {
    user,
    action: input.auditAction,
    entityId: requestId,
    beforeJson: null,
    afterJson: auditAfter,
    idempotencyKey,
    now,
  }));

  try {
    await db.batch(statements);
  } catch (error) {
    throw translatePurchaseDatabaseError(error);
  }
  return { request: await getPurchaseRequest(db, user.tenantId, requestId), replayed: false };
}

export async function executePurchaseRequestAction(
  db: D1Database,
  user: UserContext,
  purchaseRequestId: string,
  input: PurchaseRequestActionInput,
  idempotencyKey: string,
  options: PurchaseWorkflowOptions = {},
) {
  validateIdempotencyKey(idempotencyKey);
  const transition = ACTION_TRANSITIONS[input.action];
  requirePermission(user, transition.permission);

  const current = await getCurrentPurchaseRequest(db, user.tenantId, purchaseRequestId);
  const actorMemberId = await resolveActorMemberId(db, user);
  assertAssignedActor(current, actorMemberId, input.action);
  if ((input.action === 'submit' || input.action === 'approve')
    && options.developmentOpenAccess !== true) {
    assertReviewerSeparation(
      current.purchaser_member_id,
      current.reviewer_member_id,
      false,
    );
  }

  const receipt = await db.prepare(`
    SELECT entity_id, action
    FROM audit_logs
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{ entity_id: string; action: string }>();
  if (receipt) {
    if (receipt.entity_id !== purchaseRequestId || receipt.action !== transition.auditAction) {
      throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
    }
    return {
      request: await getPurchaseRequest(db, user.tenantId, purchaseRequestId),
      replayed: true,
    };
  }

  if (current.status !== transition.from) {
    throw new HttpError(409, '当前采购申请状态不允许执行该操作', 'INVALID_PURCHASE_REQUEST_TRANSITION');
  }
  if (input.action === 'submit' || input.action === 'approve') {
    await assertRequestDemandsStillValid(db, user.tenantId, purchaseRequestId);
    await assertRequestPlanningStillValid(db, user, current, options);
  }
  if (input.action === 'withdraw') {
    await assertNoActivePurchaseOrder(db, user.tenantId, purchaseRequestId);
  }

  const now = (options.now ?? new Date()).toISOString();
  const actionRequestId = crypto.randomUUID();
  const beforeJson = JSON.stringify({ status: current.status, version: current.version });
  const afterJson = JSON.stringify({
    status: transition.to,
    version: current.version + 1,
    note: input.note?.trim() || null,
  });
  const releaseLines = input.action === 'reject'
    || input.action === 'cancel'
    || input.action === 'withdraw';
  const refreshSnapshots = input.action === 'submit' || input.action === 'approve';
  const activeOrderGuard = input.action === 'withdraw'
    ? `AND NOT EXISTS (
        SELECT 1 FROM purchase_orders po
        WHERE po.tenant_id = purchase_requests.tenant_id
          AND po.purchase_request_id = purchase_requests.id
          AND po.status <> 'cancelled'
      )`
    : '';
  const statements: D1PreparedStatement[] = [];
  if (refreshSnapshots) {
    statements.push(db.prepare(`
      UPDATE purchase_request_lines
      SET source_required_quantity = (
            SELECT pd.required_quantity FROM purchase_demands pd
            WHERE pd.id = purchase_request_lines.purchase_demand_id
              AND pd.tenant_id = purchase_request_lines.tenant_id
          ),
          source_updated_at = (
            SELECT pd.source_updated_at FROM purchase_demands pd
            WHERE pd.id = purchase_request_lines.purchase_demand_id
              AND pd.tenant_id = purchase_request_lines.tenant_id
          )
      WHERE request_id = ? AND tenant_id = ? AND active = 1
        AND EXISTS (
          SELECT 1 FROM purchase_requests pr
          WHERE pr.id = purchase_request_lines.request_id
            AND pr.tenant_id = purchase_request_lines.tenant_id
            AND pr.status = ? AND pr.version = ?
        )
    `).bind(purchaseRequestId, user.tenantId, current.status, current.version));
  }
  statements.push(db.prepare(`
    UPDATE purchase_requests
    SET status = ?,
        review_note = CASE WHEN ? IN ('approved', 'rejected') OR ? = 'withdraw' THEN ? ELSE review_note END,
        submitted_at = CASE WHEN ? = 'pending_review' THEN ? ELSE submitted_at END,
        reviewed_at = CASE WHEN ? IN ('approved', 'rejected') THEN ? ELSE reviewed_at END,
        version = version + 1,
        last_action_key = ?,
        updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = ? AND version = ?
      ${activeOrderGuard}
  `).bind(
    transition.to,
    transition.to,
    input.action,
    input.note?.trim() || null,
    transition.to,
    now,
    transition.to,
    now,
    idempotencyKey,
    now,
    purchaseRequestId,
    user.tenantId,
    current.status,
    current.version,
  ));
  if (releaseLines) {
    statements.push(db.prepare(`
      UPDATE purchase_request_lines
      SET active = 0
      WHERE request_id = ? AND tenant_id = ? AND active = 1
        AND EXISTS (
          SELECT 1 FROM purchase_requests pr
          WHERE pr.id = purchase_request_lines.request_id
            AND pr.tenant_id = purchase_request_lines.tenant_id
            AND pr.last_action_key = ? AND pr.status = ?
        )
    `).bind(purchaseRequestId, user.tenantId, idempotencyKey, transition.to));
  }
  statements.push(db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    )
    SELECT ?, ?, ?, ?, ?, 'purchase_request', ?, ?, ?, ?, ?, 'human', ?
    FROM purchase_requests pr
    WHERE pr.id = ? AND pr.tenant_id = ? AND pr.last_action_key = ? AND pr.status = ?
  `).bind(
    crypto.randomUUID(),
    user.tenantId,
    user.id,
    user.email,
    transition.auditAction,
    purchaseRequestId,
    beforeJson,
    afterJson,
    actionRequestId,
    idempotencyKey,
    now,
    purchaseRequestId,
    user.tenantId,
    idempotencyKey,
    transition.to,
  ));

  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    throw translatePurchaseDatabaseError(error);
  }
  const updateResultIndex = refreshSnapshots ? 1 : 0;
  if (Number(results[updateResultIndex]?.meta?.changes ?? 0) !== 1) {
    if (input.action === 'withdraw') {
      await assertNoActivePurchaseOrder(db, user.tenantId, purchaseRequestId);
    }
    throw new HttpError(409, '采购申请已被其他操作更新，请刷新后重试', 'CONCURRENT_UPDATE');
  }
  return {
    request: await getPurchaseRequest(db, user.tenantId, purchaseRequestId),
    replayed: false,
  };
}

export async function getPurchaseRequest(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`${PURCHASE_REQUEST_SELECT}
    WHERE pr.tenant_id = ? AND pr.id = ?
    GROUP BY pr.id
    LIMIT 1
  `).bind(tenantId, id).first<PurchaseRequestRow>();
  if (!row) throw new HttpError(404, '采购申请不存在或不在当前数据范围内', 'PURCHASE_REQUEST_NOT_FOUND');
  const lines = await db.prepare(`${PURCHASE_REQUEST_LINE_SELECT}
    WHERE pr.tenant_id = ? AND pr.id = ?
    ORDER BY line.created_at ASC
  `).bind(tenantId, id).all<PurchaseRequestLineRow>();
  return mapRequest(row, lines.results.map(mapRequestLine));
}

const PURCHASE_REQUEST_SELECT = `
  SELECT
    pr.id,
    pr.request_no,
    pr.status,
    pr.purchaser_member_id,
    purchaser.display_name AS purchaser_name,
    purchaser.role AS purchaser_role,
    pr.reviewer_member_id,
    reviewer.display_name AS reviewer_name,
    reviewer.role AS reviewer_role,
    pr.created_by_member_id AS creator_member_id,
    creator.display_name AS creator_name,
    creator.role AS creator_role,
    pr.note,
    pr.review_note,
    pr.version,
    pr.submitted_at,
    pr.reviewed_at,
    pr.created_at,
    pr.updated_at,
    COUNT(line.id) AS line_count,
    COALESCE(SUM(line.requested_quantity), 0) AS total_quantity,
    COALESCE(MAX(CASE WHEN pr.status = 'approved' AND line.active = 1 AND (
      pd.id IS NULL OR pd.status <> 'open' OR pd.mapped_sku_id <> line.sku_id
      OR pd.required_quantity < line.requested_quantity
      OR pd.source_updated_at <> line.source_updated_at
    ) THEN 1 ELSE 0 END), 0) AS needs_attention
  FROM purchase_requests pr
  JOIN members purchaser ON purchaser.id = pr.purchaser_member_id AND purchaser.tenant_id = pr.tenant_id
  JOIN members reviewer ON reviewer.id = pr.reviewer_member_id AND reviewer.tenant_id = pr.tenant_id
  JOIN members creator ON creator.id = pr.created_by_member_id AND creator.tenant_id = pr.tenant_id
  LEFT JOIN purchase_request_lines line ON line.request_id = pr.id AND line.tenant_id = pr.tenant_id
  LEFT JOIN purchase_demands pd ON pd.id = line.purchase_demand_id AND pd.tenant_id = line.tenant_id
`;

const PURCHASE_REQUEST_LINE_SELECT = `
  SELECT
    line.id,
    line.request_id,
    line.purchase_demand_id,
    line.sku_id,
    sku.code AS sku_code,
    sku.name AS sku_name,
    line.requested_quantity,
    line.source_required_quantity,
    line.source_updated_at,
    line.active,
    pd.status AS current_status,
    pd.required_quantity AS current_required_quantity,
    pd.mapped_sku_id AS current_mapped_sku_id,
    pd.source_updated_at AS current_source_updated_at,
    store.display_name AS store_name,
    po.source_order_name,
    pd.source_order_id,
    pd.source_order_line_id,
    pd.raw_sku,
    pol.title
  FROM purchase_request_lines line
  JOIN purchase_requests pr ON pr.id = line.request_id AND pr.tenant_id = line.tenant_id
  JOIN purchase_demands pd ON pd.id = line.purchase_demand_id AND pd.tenant_id = line.tenant_id
  JOIN skus sku ON sku.id = line.sku_id AND sku.tenant_id = line.tenant_id
  JOIN platform_stores store ON store.id = pd.platform_store_id AND store.tenant_id = pd.tenant_id
  JOIN platform_orders po ON po.id = pd.order_id AND po.tenant_id = pd.tenant_id
  JOIN platform_order_lines pol ON pol.id = pd.order_line_id AND pol.tenant_id = pd.tenant_id
`;

function mapRequest(row: PurchaseRequestRow, lines: ReturnType<typeof mapRequestLine>[]) {
  return {
    id: row.id,
    requestNo: row.request_no,
    status: row.status,
    purchaser: {
      id: row.purchaser_member_id,
      displayName: row.purchaser_name,
      role: row.purchaser_role,
    },
    reviewer: {
      id: row.reviewer_member_id,
      displayName: row.reviewer_name,
      role: row.reviewer_role,
    },
    creator: {
      id: row.creator_member_id,
      displayName: row.creator_name,
      role: row.creator_role,
    },
    note: row.note,
    reviewNote: row.review_note,
    version: Number(row.version),
    lineCount: Number(row.line_count),
    totalQuantity: Number(row.total_quantity),
    needsAttention: Number(row.needs_attention) === 1,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
  };
}

function mapRequestLine(row: PurchaseRequestLineRow) {
  return {
    id: row.id,
    demandId: row.purchase_demand_id,
    purchaseDemandId: row.purchase_demand_id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    requestedQuantity: Number(row.requested_quantity),
    sourceRequiredQuantity: Number(row.source_required_quantity),
    sourceUpdatedAt: row.source_updated_at,
    active: Boolean(row.active),
    currentStatus: row.current_status,
    currentRequiredQuantity: Number(row.current_required_quantity),
    currentSourceUpdatedAt: row.current_source_updated_at,
    needsAttention: row.active === 1 && (
      row.current_status !== 'open'
      || row.current_mapped_sku_id !== row.sku_id
      || Number(row.current_required_quantity) < Number(row.requested_quantity)
      || row.current_source_updated_at !== row.source_updated_at
    ),
    storeName: row.store_name,
    sourceOrderName: row.source_order_name,
    sourceOrderId: row.source_order_id,
    sourceOrderLineId: row.source_order_line_id,
    rawSku: row.raw_sku,
    title: row.title,
  };
}

async function resolveActorMemberId(db: D1Database, user: UserContext) {
  const member = await db.prepare(`
    SELECT id FROM members
    WHERE tenant_id = ? AND auth_user_id = ?
    LIMIT 1
  `).bind(user.tenantId, user.id).first<{ id: string }>();
  if (!member) throw new HttpError(409, '当前操作人尚未加入采购工作区', 'PURCHASE_MEMBER_NOT_FOUND');
  return member.id;
}

async function validateAssignedMembers(
  db: D1Database,
  tenantId: string,
  purchaserMemberId: string,
  reviewerMemberId: string,
) {
  const ids = [...new Set([purchaserMemberId, reviewerMemberId])];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT id, role FROM members
    WHERE tenant_id = ? AND id IN (${placeholders})
  `).bind(tenantId, ...ids).all<{ id: string; role: Role }>();
  if (rows.results.length !== ids.length) {
    throw new HttpError(400, '采购负责人或复审人不在当前工作区', 'PURCHASE_ASSIGNEE_INVALID');
  }
  const memberById = new Map(rows.results.map((member) => [member.id, member]));
  const purchaser = memberById.get(purchaserMemberId);
  const reviewer = memberById.get(reviewerMemberId);
  if (!purchaser || !ROLE_PERMISSIONS[purchaser.role]?.includes('purchase:submit')) {
    throw new HttpError(
      400,
      '采购负责人必须是管理员或操作员，且具备提交采购申请权限',
      'PURCHASE_PURCHASER_PERMISSION_REQUIRED',
    );
  }
  if (!reviewer || !ROLE_PERMISSIONS[reviewer.role]?.includes('purchase:review')) {
    throw new HttpError(
      400,
      '复审人必须是管理员，且具备采购复审权限',
      'PURCHASE_REVIEWER_PERMISSION_REQUIRED',
    );
  }
}

function assertReviewerSeparation(
  purchaserMemberId: string,
  reviewerMemberId: string,
  developmentOpenAccess: boolean,
) {
  if (!developmentOpenAccess && purchaserMemberId === reviewerMemberId) {
    throw new HttpError(
      409,
      '正式模式要求采购负责人和复审人为不同成员，请重新分配后再继续',
      'PURCHASE_REVIEWER_MUST_DIFFER',
    );
  }
}

function assertAssignedActor(
  request: Pick<CurrentRequestRow, 'purchaser_member_id' | 'reviewer_member_id'>,
  actorMemberId: string,
  action: PurchaseRequestAction,
) {
  const purchaserAction = action === 'submit' || action === 'cancel' || action === 'withdraw';
  const assignedMemberId = purchaserAction
    ? request.purchaser_member_id
    : request.reviewer_member_id;
  if (actorMemberId !== assignedMemberId) {
    throw new HttpError(
      403,
      purchaserAction
        ? '只有该申请指定的采购负责人可以提交、取消或撤回'
        : '只有该申请指定的复审人可以批准或驳回',
      purchaserAction ? 'PURCHASE_PURCHASER_REQUIRED' : 'PURCHASE_REVIEWER_REQUIRED',
    );
  }
}

async function assertNoActivePurchaseOrder(
  db: D1Database,
  tenantId: string,
  purchaseRequestId: string,
) {
  const order = await db.prepare(`
    SELECT id FROM purchase_orders
    WHERE tenant_id = ? AND purchase_request_id = ? AND status <> 'cancelled'
    LIMIT 1
  `).bind(tenantId, purchaseRequestId).first<{ id: string }>();
  if (order) {
    throw new HttpError(
      409,
      '该申请已生成有效采购单，不能撤回；请先按真实供应商状态处理采购单',
      'PURCHASE_REQUEST_HAS_ACTIVE_ORDER',
    );
  }
}

async function loadCreateDemands(db: D1Database, tenantId: string, demandIds: string[]) {
  const placeholders = demandIds.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT
      pd.id,
      pd.status,
      pd.mapped_sku_id,
      pd.required_quantity,
      pd.source_updated_at,
      active_line.id AS active_line_id
    FROM purchase_demands pd
    LEFT JOIN purchase_request_lines active_line
      ON active_line.tenant_id = pd.tenant_id
      AND active_line.purchase_demand_id = pd.id
      AND active_line.active = 1
    WHERE pd.tenant_id = ? AND pd.id IN (${placeholders})
  `).bind(tenantId, ...demandIds).all<CreateDemandRow>();
  return rows.results;
}

function validateCreateDemands(demandIds: string[], demands: CreateDemandRow[]) {
  if (demands.length !== demandIds.length) {
    throw new HttpError(404, '部分采购需求不存在或不在当前数据范围内', 'PURCHASE_DEMAND_NOT_FOUND');
  }
  for (const demand of demands) {
    if (demand.status !== 'open' || !demand.mapped_sku_id || Number(demand.required_quantity) <= 0) {
      throw new HttpError(409, '所选需求尚未完成 SKU 映射或已无需采购', 'PURCHASE_DEMAND_NOT_OPEN');
    }
    if (demand.active_line_id) {
      throw new HttpError(409, '所选需求已经进入其他采购申请，不能重复采购', 'PURCHASE_DEMAND_ALREADY_ALLOCATED');
    }
  }
}

async function getCurrentPurchaseRequest(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`
    SELECT
      pr.id,
      pr.status,
      pr.version,
      pr.purchaser_member_id,
      pr.reviewer_member_id,
      (
        SELECT log.after_json
        FROM audit_logs log
        WHERE log.tenant_id = pr.tenant_id
          AND log.entity_type = 'purchase_request'
          AND log.entity_id = pr.id
          AND log.action = 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
        ORDER BY log.created_at, log.id
        LIMIT 1
      ) AS planning_audit_json
    FROM purchase_requests pr
    WHERE pr.tenant_id = ? AND pr.id = ?
    LIMIT 1
  `).bind(tenantId, id).first<CurrentRequestRow>();
  if (!row) throw new HttpError(404, '采购申请不存在或不在当前数据范围内', 'PURCHASE_REQUEST_NOT_FOUND');
  return row;
}

async function assertRequestPlanningStillValid(
  db: D1Database,
  user: UserContext,
  request: CurrentRequestRow,
  options: PurchaseWorkflowOptions,
) {
  if (request.planning_audit_json === null) return;
  const audit = parseJsonObject(request.planning_audit_json);
  const evidence = audit?.planningEvidence;
  if (!isPurchasePlanningEvidence(evidence)) {
    throw new HttpError(
      409,
      '该旧版采购建议草稿缺少可复验依据，请刷新采购建议并重新生成申请',
      'PURCHASE_PLAN_EVIDENCE_MISSING',
    );
  }
  const { assertPurchaseRequestPlanningEvidenceCurrent } = await import('./purchase-planning-service');
  await assertPurchaseRequestPlanningEvidenceCurrent(db, user, request.id, evidence, {
    now: options.now,
    maxAgeMinutes: options.maxAgeMinutes,
    sourceMaxAgeMinutes: options.sourceMaxAgeMinutes,
    runtimeEnv: options.runtimeEnv,
  });
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isPurchasePlanningEvidence(value: unknown): value is PurchasePlanningEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PurchasePlanningEvidence>;
  return candidate.schemaVersion === 1
    && Array.isArray(candidate.rows)
    && candidate.rows.length > 0
    && candidate.rows.every((row) => row !== null && typeof row === 'object'
      && typeof row.planRowId === 'string'
      && typeof row.skuId === 'string'
      && typeof row.recommendationVersion === 'string'
      && Array.isArray(row.allocations)
      && row.allocations.length > 0
      && row.allocations.every((allocation) => allocation !== null
        && typeof allocation === 'object'
        && typeof allocation.demandId === 'string'
        && Number.isSafeInteger(allocation.quantity)
        && allocation.quantity > 0));
}

async function assertRequestDemandsStillValid(db: D1Database, tenantId: string, requestId: string) {
  const invalid = await db.prepare(`
    SELECT
      COUNT(*) AS total_lines,
      COALESCE(SUM(CASE WHEN pd.id IS NULL OR pd.status <> 'open'
        OR pd.mapped_sku_id <> line.sku_id
        OR pd.required_quantity < line.requested_quantity THEN 1 ELSE 0 END), 0) AS invalid_lines
    FROM purchase_request_lines line
    LEFT JOIN purchase_demands pd
      ON pd.id = line.purchase_demand_id AND pd.tenant_id = line.tenant_id
    WHERE line.tenant_id = ? AND line.request_id = ? AND line.active = 1
  `).bind(tenantId, requestId).first<{ total_lines: number; invalid_lines: number }>();
  if (!invalid || Number(invalid.total_lines) === 0 || Number(invalid.invalid_lines) > 0) {
    throw new HttpError(409, '订单需求已变化，请刷新采购申请后重新提交', 'PURCHASE_DEMAND_CHANGED');
  }
}

function auditInsertStatement(db: D1Database, input: {
  user: UserContext;
  action: string;
  entityId: string;
  beforeJson: string | null;
  afterJson: string | null;
  idempotencyKey: string;
  now: string;
}) {
  return db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    ) VALUES (?, ?, ?, ?, ?, 'purchase_request', ?, ?, ?, ?, ?, 'human', ?)
  `).bind(
    crypto.randomUUID(),
    input.user.tenantId,
    input.user.id,
    input.user.email,
    input.action,
    input.entityId,
    input.beforeJson,
    input.afterJson,
    crypto.randomUUID(),
    input.idempotencyKey,
    input.now,
  );
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function hashPayload(input: unknown) {
  const stable = JSON.stringify(input);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createPurchaseRequestNumber() {
  const date = new Date().toISOString().slice(2, 10).replaceAll('-', '');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  return `CG${date}-${suffix}`;
}

function translatePurchaseDatabaseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('INVALID_PURCHASE_DEMAND') || message.includes('PURCHASE_DEMAND_CHANGED')) {
    return new HttpError(409, '订单需求已变化，请刷新后重试', 'PURCHASE_DEMAND_CHANGED');
  }
  if (message.includes('INVALID_PURCHASE_REQUEST_TRANSITION')) {
    return new HttpError(409, '当前采购申请状态不允许执行该操作', 'INVALID_PURCHASE_REQUEST_TRANSITION');
  }
  if (message.includes('PURCHASE_REQUEST_HAS_ACTIVE_ORDER')) {
    return new HttpError(
      409,
      '该申请已生成有效采购单，不能撤回；请先按真实供应商状态处理采购单',
      'PURCHASE_REQUEST_HAS_ACTIVE_ORDER',
    );
  }
  if (message.includes('PURCHASE_REQUEST_HAS_NO_ACTIVE_LINES')) {
    return new HttpError(409, '采购申请没有可提交的需求', 'PURCHASE_REQUEST_EMPTY');
  }
  if (
    message.includes('uq_purchase_request_lines_active_demand')
    || message.includes('purchase_request_lines.tenant_id, purchase_request_lines.purchase_demand_id')
  ) {
    return new HttpError(409, '所选需求已经进入其他采购申请，不能重复采购', 'PURCHASE_DEMAND_ALREADY_ALLOCATED');
  }
  return error;
}
