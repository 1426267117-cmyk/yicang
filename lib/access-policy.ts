export type ProductionAccessPolicy = {
  emails: Set<string>;
  domains: Set<string>;
  configured: boolean;
};

export function readProductionAccessPolicy(runtimeEnv: Record<string, unknown>): ProductionAccessPolicy {
  const emails = new Set(splitEnvList(runtimeEnv.ERP_ALLOWED_EMAILS).map((value) => value.toLowerCase()));
  const domains = new Set(
    splitEnvList(runtimeEnv.ERP_ALLOWED_EMAIL_DOMAINS)
      .map((value) => value.toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  );
  return { emails, domains, configured: emails.size > 0 || domains.size > 0 };
}

export function identityAllowed(email: string, policy: ProductionAccessPolicy) {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.includes('@') ? normalized.split('@').pop() ?? '' : '';
  return policy.emails.has(normalized) || policy.domains.has(domain);
}

export function identityExplicitlyListed(email: string, policy: ProductionAccessPolicy) {
  return policy.emails.has(email.trim().toLowerCase());
}

function splitEnvList(value: unknown) {
  return typeof value === 'string'
    ? value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)
    : [];
}
