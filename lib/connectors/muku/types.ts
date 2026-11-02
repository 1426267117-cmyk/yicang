export const MUKU_DATASETS = [
  'manifest',
  'inventory',
  'inventory-details',
  'fulfillment-orders',
  'inventory-daily',
  'shopify-daily',
  'shopify-finance',
  'shopify-sku-30d',
  'channel-daily',
  'inventory-risk',
  'store-status',
  'source-status',
  'channel-report-runs',
] as const;

export type MukuDatasetId = (typeof MUKU_DATASETS)[number];
export type MukuBusinessDatasetId = Exclude<MukuDatasetId, 'manifest'>;
export type MukuRecord = Record<string, unknown>;

export type MukuExportFilters = {
  from?: string;
  to?: string;
  platform?: string;
  store?: string;
  sku?: string;
  warehouse?: string;
  status?: string;
  businessStatus?: string;
  sourceId?: string;
};

export type MukuPageRequest = MukuExportFilters & {
  page?: number;
  pageSize?: number;
};

export type MukuPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
};

export type MukuResponseMetadata = {
  ok: true;
  apiVersion: 'v1';
  generatedAt: string;
  source: string | null;
  grain: string | null;
  businessTimezone: string | null;
  refreshCadence: string | null;
  zeroSemantics: string | null;
  filters: MukuRecord;
};

export type MukuDataPage<T extends MukuRecord = MukuRecord> = MukuResponseMetadata & {
  dataset: MukuBusinessDatasetId;
  pagination: MukuPagination;
  data: T[];
};

export type MukuManifestDataset = MukuRecord & {
  id?: string;
  dataset?: string;
  name?: string;
};

export type MukuManifestResponse = MukuResponseMetadata & {
  dataset: 'manifest';
  datasets: MukuManifestDataset[];
  datasetIds: MukuDatasetId[];
};

export type MukuDatasetExport<T extends MukuRecord = MukuRecord> = Omit<
  MukuDataPage<T>,
  'pagination' | 'data'
> & {
  data: T[];
  pageCount: number;
  pageSize: number;
  total: number;
};

export function isMukuDatasetId(value: string): value is MukuDatasetId {
  return (MUKU_DATASETS as readonly string[]).includes(value);
}

export function isMukuBusinessDatasetId(value: string): value is MukuBusinessDatasetId {
  return value !== 'manifest' && isMukuDatasetId(value);
}
