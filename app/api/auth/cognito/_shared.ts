import { env } from 'cloudflare:workers';
import type { createCognitoIdentity } from '../../../../lib/aws/cognito-identity';

export function cognitoIdentity() {
  const runtime = env as unknown as {
    ERP_HOST_RUNTIME?: string;
    ERP_AWS_AUTH_MODE?: string;
    cognitoIdentity?: ReturnType<typeof createCognitoIdentity>;
  };
  return runtime.ERP_HOST_RUNTIME === 'aws' && runtime.ERP_AWS_AUTH_MODE === 'cognito'
    ? runtime.cognitoIdentity
    : undefined;
}
