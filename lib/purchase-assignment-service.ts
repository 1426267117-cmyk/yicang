import type { ReassignPurchaseRequestInput } from './purchase-assignment-contracts';
import { HttpError, requirePermission, type UserContext } from './db';
import { ROLE_PERMISSIONS, type Role } from './domain';

type RequestAssignmentRow = {
  id: string;
  status: string;
  version: number;
  purchaser_member_id: string;
  purchaser_name: string;
  purchaser_role: Role;
  reviewer_member_id: string;
  reviewer_name: string;
  reviewer_role: Role;
};

type AssignmentMemberRow = {
  id: string;
  display_name: string;
  role: Role;
};

const ACTIVE_REQUEST_STATUSES = new Set(['draft', 'pending_review', 'approved']);

export async function reassignPurchaseRequest(
  db: D1Database,
  user: UserContext,
  purchaseRequestId: string,
  input: ReassignPurchaseRequestInput,
  idempotencyKey: string,
  options: { developmentOpenAccess?: boolean } = {},
) {
  requirePermission(user, 'members:manage');
  validateIdempotencyKey(idempotencyKey);
  const normalized = {
    purchaserMemberId: input.purchaserMemberId.trim(),
    reviewerMemberId: input.reviewerMemberId.trim(),
    reason: input.reason.trim(),
    expectedVersion: input.expectedVersion,
  };
  const requestHash = await hashPayload(normalized);
  const replay = await readReplay(db, user.tenantId, purchaseRequestId, idempotencyKey);
  if (replay) {
    assertReplayHash(replay.after_json, requestHash);
    return {
      assignment: await getPurchaseRequestAssignment(db, user.tenantId, purchaseRequestId),
      replayed: true,
    };
  }

  const current = await getPurchaseRequestAssignment(db, user.tenantId, purchaseRequestId);
  if (!ACTIVE_REQUEST_STATUSES.has(current.status)) {
    throw new HttpError(409, '只有未结束的采购申请可以重新指派', 'PURCHASE_ASSIGNMENT_TERMINAL');
  }
  if (current.version !== normalized.expectedVersion) {
    throw new HttpError(409, '采购申请已发生变化，请刷新后重新指派', 'PURCHASE_ASSIGNMENT_VERSION_CONFLICT');
  }
  if (current.purchaser.id === normalized.purchaserMemberId
    && current.reviewer.id === normalized.reviewerMemberId) {
    throw new HttpError(400, '新负责人和复审人与当前指派相同', 'PURCHASE_ASSIGNMENT_UNCHANGED');
  }

  const members = await loadAssignmentMembers(db, user.tenantId, [
    normalized.purchaserMemberId,
    normalized.reviewerMemberId,
  ]);
  const purchaser = members.get(normalized.purchaserMemberId);
  const reviewer = members.get(normalized.reviewerMemberId);
  assertEligibleAssignments(
    purchaser,
    reviewer,
    normalized.purchaserMemberId,
    normalized.reviewerMemberId,
    options.developmentOpenAccess === true,
  );

  const now = new Date().toISOString();
  const nextVersion = current.version + 1;
  const beforeJson = stableJson({
    purchaserMemberId: current.purchaser.id,
    reviewerMemberId: current.reviewer.id,
    version: current.version,
  });
  const afterJson = stableJson({
    requestHash,
    purchaserMemberId: normalized.purchaserMemberId,
    reviewerMemberId: normalized.reviewerMemberId,
    reason: normalized.reason,
    version: nextVersion,
  });

  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(`
        UPDATE purchase_requests
        SET purchaser_member_id = ?, reviewer_member_id = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND version = ?
          AND status IN ('draft', 'pending_review', 'approved')
          AND EXISTS (
            SELECT 1 FROM members purchaser
            WHERE purchaser.id = ? AND purchaser.tenant_id = purchase_requests.tenant_id
              AND purchaser.role IN ('admin', 'operator')
          )
          AND EXISTS (
            SELECT 1 FROM members reviewer
            WHERE reviewer.id = ? AND reviewer.tenant_id = purchase_requests.tenant_id
              AND reviewer.role = 'admin'
          )
          AND (? = 1 OR ? <> ?)
      `).bind(
        normalized.purchaserMemberId,
        normalized.reviewerMemberId,
        now,
        purchaseRequestId,
        user.tenantId,
        current.version,
        normalized.purchaserMemberId,
        normalized.reviewerMemberId,
        options.developmentOpenAccess === true ? 1 : 0,
        normalized.purchaserMemberId,
        normalized.reviewerMemberId,
      ),
      db.prepare(`
        INSERT INTO audit_logs (
          id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
          before_json, after_json, request_id, idempotency_key, source, created_at
        )
        SELECT ?, ?, ?, ?, 'REASSIGN_PURCHASE_REQUEST', 'purchase_request', ?,
          ?, ?, ?, ?, 'human', ?
        FROM purchase_requests request
        WHERE changes() = 1
          AND request.id = ? AND request.tenant_id = ?
          AND request.version = ?
          AND request.purchaser_member_id = ?
          AND request.reviewer_member_id = ?
          AND request.updated_at = ?
      `).bind(
        crypto.randomUUID(),
        user.tenantId,
        user.id,
        user.email,
        purchaseRequestId,
        beforeJson,
        afterJson,
        crypto.randomUUID(),
        idempotencyKey,
        now,
        purchaseRequestId,
        user.tenantId,
        nextVersion,
        normalized.purchaserMemberId,
        normalized.reviewerMemberId,
        now,
      ),
    ]);
  } catch (error) {
    const concurrentReplay = await readReplay(db, user.tenantId, purchaseRequestId, idempotencyKey);
    if (concurrentReplay) {
      assertReplayHash(concurrentReplay.after_json, requestHash);
      return {
        assignment: await getPurchaseRequestAssignment(db, user.tenantId, purchaseRequestId),
        replayed: true,
      };
    }
    throw error;
  }

  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const latest = await getPurchaseRequestAssignment(db, user.tenantId, purchaseRequestId);
    if (!ACTIVE_REQUEST_STATUSES.has(latest.status)) {
      throw new HttpError(409, '采购申请已经结束，不能重新指派', 'PURCHASE_ASSIGNMENT_TERMINAL');
    }
    if (latest.version !== current.version) {
      throw new HttpError(409, '采购申请已发生变化，请刷新后重新指派', 'PURCHASE_ASSIGNMENT_VERSION_CONFLICT');
    }
    throw new HttpError(409, '成员角色已变化，请刷新后重新指派', 'PURCHASE_ASSIGNMENT_MEMBER_CHANGED');
  }

  const applied = await readReplay(db, user.tenantId, purchaseRequestId, idempotencyKey);
  if (!applied) {
    throw new HttpError(500, '负责人已更新但审计记录缺失，事务已拒绝', 'PURCHASE_ASSIGNMENT_AUDIT_MISSING');
  }
  return {
    assignment: await getPurchaseRequestAssignment(db, user.tenantId, purchaseRequestId),
    replayed: false,
  };
}

export async function getPurchaseRequestAssignment(
  db: D1Database,
  tenantId: string,
  purchaseRequestId: string,
) {
  const row = await db.prepare(`
    SELECT request.id, request.status, request.version,
      request.purchaser_member_id, purchaser.display_name AS purchaser_name,
      purchaser.role AS purchaser_role,
      request.reviewer_member_id, reviewer.display_name AS reviewer_name,
      reviewer.role AS reviewer_role
    FROM purchase_requests request
    JOIN members purchaser
      ON purchaser.id = request.purchaser_member_id AND purchaser.tenant_id = request.tenant_id
    JOIN members reviewer
      ON reviewer.id = request.reviewer_member_id AND reviewer.tenant_id = request.tenant_id
    WHERE request.id = ? AND request.tenant_id = ?
    LIMIT 1
  `).bind(purchaseRequestId, tenantId).first<RequestAssignmentRow>();
  if (!row) {
    throw new HttpError(404, '采购申请不存在或不在当前工作区', 'PURCHASE_REQUEST_NOT_FOUND');
  }
  return {
    requestId: row.id,
    status: row.status,
    version: Number(row.version),
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
  };
}

async function loadAssignmentMembers(db: D1Database, tenantId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT id, display_name, role FROM members
    WHERE tenant_id = ? AND id IN (${placeholders})
  `).bind(tenantId, ...uniqueIds).all<AssignmentMemberRow>();
  return new Map(rows.results.map((member) => [member.id, member]));
}

function assertEligibleAssignments(
  purchaser: AssignmentMemberRow | undefined,
  reviewer: AssignmentMemberRow | undefined,
  purchaserMemberId: string,
  reviewerMemberId: string,
  developmentOpenAccess: boolean,
) {
  if (!purchaser || !ROLE_PERMISSIONS[purchaser.role]?.includes('purchase:submit')) {
    throw new HttpError(
      400,
      '采购负责人必须是当前工作区内具备提交权限的管理员或操作员',
      'PURCHASE_PURCHASER_PERMISSION_REQUIRED',
    );
  }
  if (!reviewer || !ROLE_PERMISSIONS[reviewer.role]?.includes('purchase:review')) {
    throw new HttpError(
      400,
      '复审人必须是当前工作区内具备复审权限的管理员',
      'PURCHASE_REVIEWER_PERMISSION_REQUIRED',
    );
  }
  if (!developmentOpenAccess && purchaserMemberId === reviewerMemberId) {
    throw new HttpError(
      409,
      '正式模式要求采购负责人和复审人为不同成员',
      'PURCHASE_REVIEWER_MUST_DIFFER',
    );
  }
}

async function readReplay(
  db: D1Database,
  tenantId: string,
  purchaseRequestId: string,
  idempotencyKey: string,
) {
  const row = await db.prepare(`
    SELECT entity_id, action, after_json
    FROM audit_logs
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<{
    entity_id: string;
    action: string;
    after_json: string | null;
  }>();
  if (!row) return null;
  if (row.entity_id !== purchaseRequestId || row.action !== 'REASSIGN_PURCHASE_REQUEST') {
    throw new HttpError(409, '该幂等键已用于其他业务操作', 'IDEMPOTENCY_CONFLICT');
  }
  return row;
}

function assertReplayHash(afterJson: string | null, requestHash: string) {
  let storedHash: unknown;
  try {
    storedHash = afterJson ? (JSON.parse(afterJson) as Record<string, unknown>).requestHash : null;
  } catch {
    storedHash = null;
  }
  if (storedHash !== requestHash) {
    throw new HttpError(409, '同一幂等键不能用于不同的重新指派参数', 'IDEMPOTENCY_CONFLICT');
  }
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function hashPayload(input: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableJson(input)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null';
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
