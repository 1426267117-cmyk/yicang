export type OrderSourceReadinessInput = {
  credentialRef: string;
  connectorKey: string;
  identityVerifiedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  syncLastSuccessAt: string | null;
  syncStatus: string | null;
};

export type OrderSourceReadiness = {
  official: boolean;
  ready: boolean;
  identityVerified: boolean;
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  reasons: string[];
};

export function evaluateOrderSourceReadiness(
  source: OrderSourceReadinessInput,
  options: { checkedAt: string; maxAgeMinutes: number },
): OrderSourceReadiness {
  const checkedAt = validTimestamp(options.checkedAt);
  const official = !isLocalQaSource(source.credentialRef, source.connectorKey);
  const reasons: string[] = [];
  if (!official) reasons.push('local_qa_excluded');

  const identityTime = validTimestamp(source.identityVerifiedAt);
  const identityVerified = official
    && checkedAt !== null
    && identityTime !== null
    && identityTime <= checkedAt;
  if (official && !identityVerified) reasons.push('identity_verification_invalid');

  const suppliedSuccessValues = [source.lastSuccessfulSyncAt, source.syncLastSuccessAt]
    .filter((value): value is string => Boolean(value));
  const lastSuccessTime = latestValidTimestamp(suppliedSuccessValues);
  const lastSuccessAt = lastSuccessTime === null ? null : new Date(lastSuccessTime).toISOString();
  const ageMinutes = checkedAt === null || lastSuccessTime === null
    ? null
    : roundMinutes(checkedAt - lastSuccessTime);

  if (official && suppliedSuccessValues.length === 0) {
    reasons.push('order_sync_time_unknown');
  } else if (official && lastSuccessTime === null) {
    reasons.push('order_sync_time_invalid');
  } else if (official && checkedAt === null) {
    reasons.push('order_sync_check_time_invalid');
  } else if (official && lastSuccessTime !== null && checkedAt !== null) {
    if (lastSuccessTime > checkedAt) reasons.push('order_sync_time_in_future');
    else if (ageMinutes !== null && ageMinutes > options.maxAgeMinutes) reasons.push('order_sync_stale');
  }
  if (official && source.syncStatus === 'failed') reasons.push('order_sync_failed');

  return {
    official,
    ready: official && reasons.length === 0,
    identityVerified,
    lastSuccessAt,
    ageMinutes,
    reasons,
  };
}

export function isLocalQaSource(credentialRef: string, connectorKey: string) {
  return credentialRef.trim().toLowerCase().startsWith('local:')
    || connectorKey.trim().toLowerCase().startsWith('local_');
}

function latestValidTimestamp(values: string[]) {
  const timestamps = values
    .map((value) => validTimestamp(value))
    .filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function validTimestamp(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMinutes(milliseconds: number) {
  return Math.round((milliseconds / 60_000) * 10) / 10;
}
