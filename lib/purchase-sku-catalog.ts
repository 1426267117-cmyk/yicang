import type { PurchaseProductDetails } from './purchase-product-details';

export const skuCatalogFields = {
  specification: '规格',
  dimensions: '尺寸',
  imageUrl: '图片',
  description: '商品介绍',
} as const;

export type SkuCatalogField = keyof typeof skuCatalogFields;
export const skuCatalogFieldKeys = Object.keys(skuCatalogFields) as SkuCatalogField[];
export const skuCatalogFilters = ['all', 'incomplete', 'complete', ...skuCatalogFieldKeys] as const;
export type SkuCatalogFilter = (typeof skuCatalogFilters)[number];
export const skuCatalogPageSize = 50;

export type SkuCatalogEntry = {
  id: string;
  code: string;
  name: string;
  productDetails: PurchaseProductDetails;
  revision: string;
  missingFields: SkuCatalogField[];
};

export type SkuCatalogPage = {
  skus: SkuCatalogEntry[];
  page: number;
  total: number;
};
