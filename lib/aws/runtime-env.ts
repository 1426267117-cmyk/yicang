import { isAbsolute, resolve } from 'node:path';
import { readProductionAccessPolicy } from '../access-policy';
import { createAlbIdentityVerifier } from './alb-identity';
import { createCognitoIdentity } from './cognito-identity';
import { configuredFeishuIdentity } from './feishu-identity';
import { openSqliteD1 } from './sqlite-d1';

const runtimeKey = Symbol.for('yicang.erp.aws');
type AwsRuntime = {
  sqlite: ReturnType<typeof openSqliteD1>;
  verifyIdentity: ReturnType<typeof createAlbIdentityVerifier>;
  cognitoIdentity?: ReturnType<typeof createCognitoIdentity>;
  publicOrigin: string;
};
const nodeProcess = globalThis as typeof globalThis & { [runtimeKey]?: AwsRuntime };
const authMode = process.env.ERP_AWS_AUTH_MODE ?? 'alb';
const feishuIdentity = authMode === 'cognito' ? configuredFeishuIdentity(process.env) : undefined;

function awsRuntime() {
  if (nodeProcess[runtimeKey]) return nodeProcess[runtimeKey];

  const databasePath = process.env.ERP_SQLITE_PATH;
  if (!databasePath || !isAbsolute(databasePath)) {
    throw new Error('ERP_SQLITE_PATH must be an absolute path to the persistent database file');
  }
  const migrationsPath = process.env.ERP_SQLITE_MIGRATIONS_DIR ?? resolve('drizzle');
  if (!isAbsolute(migrationsPath)) {
    throw new Error('ERP_SQLITE_MIGRATIONS_DIR must be an absolute path');
  }
  if (!readProductionAccessPolicy(process.env).bootstrapOwnerEmail) {
    throw new Error('ERP_ALLOWED_EMAILS must start with the ERP owner email');
  }
  const publicUrl = new URL(process.env.ERP_PUBLIC_ORIGIN ?? '');
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search
    || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('ERP_PUBLIC_ORIGIN must be the HTTPS origin of this ERP instance');
  }
  if (authMode !== 'alb' && authMode !== 'cognito') {
    throw new Error('ERP_AWS_AUTH_MODE must be alb or cognito');
  }
  const oidc = {
    clientId: process.env.ERP_AWS_OIDC_CLIENT_ID ?? '',
    issuer: process.env.ERP_AWS_OIDC_ISSUER ?? '',
  };
  const cognitoIdentity = authMode === 'cognito' ? createCognitoIdentity({
    ...oidc,
    domain: process.env.ERP_AWS_COGNITO_DOMAIN ?? '',
    publicOrigin: publicUrl.origin,
    sessionSecret: process.env.ERP_AWS_SESSION_SECRET ?? '',
  }, { clearFeishuSession: Boolean(feishuIdentity) }) : undefined;
  const verifyIdentity = cognitoIdentity?.verifyIdentity ?? createAlbIdentityVerifier({
    ...oidc,
    signerArn: process.env.ERP_AWS_ALB_ARN ?? '',
  });
  const sqlite = openSqliteD1(databasePath, migrationsPath);
  const runtime = { sqlite, verifyIdentity, cognitoIdentity, publicOrigin: publicUrl.origin };
  nodeProcess[runtimeKey] = runtime;
  return runtime;
}

export const env = {
  ...process.env,
  ERP_HOST_RUNTIME: 'aws',
  ERP_AWS_AUTH_MODE: authMode,
  ERP_DEV_OPEN_ACCESS: 'false',
  ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED: 'false',
  isFeishuLoginConfigured: Boolean(feishuIdentity),
  feishuIdentity,
  get ERP_PUBLIC_ORIGIN(): string {
    return awsRuntime().publicOrigin;
  },
  get DB(): D1Database {
    return awsRuntime().sqlite.db;
  },
  get cognitoIdentity() {
    return awsRuntime().cognitoIdentity;
  },
  async verifyRequestIdentity(headers: Headers) {
    return (await feishuIdentity?.verifyIdentity(headers)) ?? awsRuntime().verifyIdentity(headers);
  },
};

export function waitUntil(task: Promise<unknown>) {
  void task.catch((error) => console.error('ERP background task failed', error));
}
