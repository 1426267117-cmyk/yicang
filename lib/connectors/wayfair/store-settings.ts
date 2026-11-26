import { z } from 'zod';
import { wayfairDropshipOrderLimit, wayfairPoNumberPattern, type WayfairDropshipConfig } from './dropship-orders';

const storeKey = 'wayfair-linhe';
const storeName = '林和';
const prefix = 'ERP_WAYFAIR_LINHE';
export const wayfairPreviewDays = 30;

export type WayfairConnectionStatus = {
  key: typeof storeKey;
  name: typeof storeName;
  configuration: 'unconfigured' | 'invalid' | 'configured';
  environment: WayfairDropshipConfig['environment'] | null;
  previewDays: number;
  maxOrders: number;
};

export type WayfairStoreConfig = WayfairDropshipConfig & { verificationPoNumber: string; verificationHasResponse: boolean };

const connectionSchema = z.strictObject({
  environment: z.enum(['production', 'sandbox']),
  supplierIds: z.array(z.string().regex(/^[1-9]\d{0,19}$/u)).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  clientId: z.string().regex(/^[!-~]{1,2048}$/u),
  clientSecret: z.string().regex(/^[!-~]{1,2048}$/u),
  verificationPoNumber: z.string().regex(wayfairPoNumberPattern),
  verificationHasResponse: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

function setting(env: Record<string, unknown>, suffix: string) {
  const value = env[`${prefix}_${suffix}`];
  return typeof value === 'string' ? value.trim() : '';
}

export function getWayfairStoreSettings(env: Record<string, unknown>, tenantId: string): {
  status: WayfairConnectionStatus; config: WayfairStoreConfig | null;
} {
  const status: WayfairConnectionStatus = {
    key: storeKey, name: storeName, configuration: 'unconfigured', environment: null,
    previewDays: wayfairPreviewDays, maxOrders: wayfairDropshipOrderLimit,
  };
  const configuredTenant = setting(env, 'TENANT_ID');
  if (!configuredTenant || configuredTenant !== tenantId) return { status, config: null };

  const parsed = connectionSchema.safeParse({
    environment: setting(env, 'ENVIRONMENT'),
    supplierIds: setting(env, 'SUPPLIER_IDS').split(',').map((value) => value.trim()),
    clientId: setting(env, 'CLIENT_ID'), clientSecret: setting(env, 'CLIENT_SECRET'),
    verificationPoNumber: setting(env, 'VERIFY_PO_NUMBER'), verificationHasResponse: setting(env, 'VERIFY_HAS_RESPONSE'),
  });
  if (!parsed.success) return { status: { ...status, configuration: 'invalid' }, config: null };
  return { status: { ...status, configuration: 'configured', environment: parsed.data.environment }, config: parsed.data };
}
