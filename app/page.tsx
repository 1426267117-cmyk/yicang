import { env } from 'cloudflare:workers';
import { isContinuousFeishuMode } from '../lib/feishu-procurement-sync';
import ErpClient from './erp-client';

export const dynamic = 'force-dynamic';

export default function Home() {
  const runtime = env as unknown as {
    ERP_HOST_RUNTIME?: string;
    ERP_AWS_AUTH_MODE?: string;
    ERP_FEISHU_MODE?: string;
    isFeishuLoginConfigured?: boolean;
  };
  const aws = runtime.ERP_HOST_RUNTIME === 'aws';
  return <ErpClient cognitoLogin={aws && runtime.ERP_AWS_AUTH_MODE === 'cognito'}
    feishuLogin={aws && runtime.isFeishuLoginConfigured === true} continuousFeishu={isContinuousFeishuMode(runtime)} />;
}
