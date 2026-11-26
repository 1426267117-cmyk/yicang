import { z } from 'zod';
import { HttpError } from '../../db';
import { createWayfairDropshipSource, WayfairConnectorError, type WayfairDropshipOptions } from './dropship-orders';
import { wayfairPreviewDays, type WayfairStoreConfig } from './store-settings';

export const wayfairPreviewSchema = z.strictObject({ hasResponse: z.boolean() });
type WayfairPreviewRequest = z.infer<typeof wayfairPreviewSchema>;

let previewInProgress = false;

export async function previewWayfairOrders(config: WayfairStoreConfig, input: WayfairPreviewRequest, options: WayfairDropshipOptions = {}) {
  if (previewInProgress) throw new HttpError(429, '已有 Wayfair 预览正在读取，请稍后重试', 'WAYFAIR_PREVIEW_BUSY');
  previewInProgress = true;
  try {
    const now = options.now ?? Date.now;
    const fromDay = new Date(now() + 8 * 3_600_000 - (wayfairPreviewDays - 1) * 86_400_000).toISOString().slice(0, 10);
    const source = createWayfairDropshipSource(config, options);
    await source.verifyOrder(config.verificationPoNumber, config.verificationHasResponse);
    const result = await source.readOrders({ hasResponse: input.hasResponse, fromDate: `${fromDay}T00:00:00+08:00` });
    return {
      ...result, readAt: new Date(now()).toISOString(), fromDay, environment: config.environment,
      orders: result.orders.map(({ poNumber, createdAt, lines }) => ({
        poNumber, createdAt,
        lines: lines.map(({ supplierSku, wayfairSku, title, quantity, cancelled }) => ({ supplierSku, wayfairSku, title, quantity, cancelled })),
      })),
    };
  } catch (error) {
    if (!(error instanceof WayfairConnectorError)) throw error;
    const status = error.code === 'WAYFAIR_RATE_LIMITED' ? 429 : error.retryable ? 503
      : ['WAYFAIR_AUTH_FAILED', 'WAYFAIR_CONFIGURATION_INVALID', 'WAYFAIR_STORE_IDENTITY_UNVERIFIED', 'WAYFAIR_SUPPLIER_MISMATCH'].includes(error.code) ? 409 : 502;
    throw new HttpError(status, error.message, error.code);
  } finally {
    previewInProgress = false;
  }
}

export type WayfairOrderPreview = Awaited<ReturnType<typeof previewWayfairOrders>>;
