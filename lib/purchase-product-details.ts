export interface PurchaseProductDetailsInput {
  name?: string | null;
  specification?: string | null;
  dimensions?: string | null;
  imageUrl?: string | null;
  description?: string | null;
}

export interface PurchaseProductDetails {
  name: string | null;
  specification: string | null;
  dimensions: string | null;
  imageUrl: string | null;
  description?: string | null;
}

const productDetailFields = ['name', 'specification', 'dimensions', 'imageUrl', 'description'] as const;
export const purchaseProductImagePath = '/api/purchase/product-images/';
export const maxPurchaseProductImageBytes = 1024 * 1024;

export function safePurchaseProductImageUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.startsWith(purchaseProductImagePath)) {
    return /^[a-f0-9]{64}$/u.test(normalized.slice(purchaseProductImagePath.length)) ? normalized : null;
  }
  if (!/^https?:\/\//iu.test(normalized)) return null;
  try {
    const url = new URL(normalized);
    if (url.username || url.password) return null;
    return normalized;
  } catch {
    return null;
  }
}

export function resolvePurchaseProductDetails(
  base: PurchaseProductDetailsInput | null,
  override?: PurchaseProductDetailsInput | null,
): PurchaseProductDetails {
  const fields = { ...base };
  for (const field of productDetailFields) {
    if (override?.[field] !== undefined) fields[field] = override[field];
  }
  return {
    name: fields.name ?? null,
    specification: fields.specification ?? null,
    dimensions: fields.dimensions ?? null,
    imageUrl: safePurchaseProductImageUrl(fields.imageUrl),
    description: fields.description ?? null,
  };
}

export function parsePurchaseProductDetails(json: string | null): PurchaseProductDetailsInput | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const details: PurchaseProductDetailsInput = {};
    for (const field of productDetailFields) {
      const value = raw[field];
      if (typeof value === 'string' || value === null) details[field] = value;
    }
    return details;
  } catch {
    return null;
  }
}
