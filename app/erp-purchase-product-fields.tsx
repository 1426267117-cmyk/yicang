'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { maxPurchaseProductImageBytes, purchaseProductImagePath, safePurchaseProductImageUrl, type PurchaseProductDetails } from '../lib/purchase-product-details';

export function readPurchaseProductDetails(data: FormData, prefix: string): PurchaseProductDetails {
  const read = (key: keyof PurchaseProductDetails) => String(data.get(`${prefix}${key}`) ?? '').trim() || null;
  return {
    name: read('name'), specification: read('specification'), dimensions: read('dimensions'),
    imageUrl: read('imageUrl'), description: read('description'),
  };
}

export function PurchaseProductImageLink({ value }: { value: string | null | undefined }) {
  const url = safePurchaseProductImageUrl(value);
  return url ? <a className="product-image-link" href={url} target="_blank" rel="noopener noreferrer">查看图片</a> : null;
}

export function PurchaseProductFields({ prefix, details, defaultName, includeName = true }: {
  prefix: string; details?: PurchaseProductDetails; defaultName?: string; includeName?: boolean;
}) {
  const [imageUrl, setImageUrl] = useState(details?.imageUrl ?? '');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  async function uploadProductImage(file: File) {
    setUploadError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > maxPurchaseProductImageBytes) {
      setUploadError('请上传 1 MB 以内的 JPG、PNG 或 WebP 图片。');
      return;
    }
    setUploading(true);
    const input = urlInput.current;
    input?.setCustomValidity('请等待图片上传完成。');
    try {
      const response = await fetch('/api/purchase/product-images', {
        method: 'POST', headers: { 'Content-Type': file.type }, body: file,
      });
      const result = await response.json().catch(() => null) as { ok?: boolean; imageUrl?: string; message?: string } | null;
      const savedUrl = safePurchaseProductImageUrl(result?.imageUrl);
      if (!response.ok || !result?.ok || !savedUrl?.startsWith(purchaseProductImagePath)) throw new Error(result?.message || '图片上传失败，请重试。');
      setImageUrl(savedUrl);
      input?.setCustomValidity('');
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : '图片上传失败，请重试。');
      input?.setCustomValidity(imageUrl.trim() && !safePurchaseProductImageUrl(imageUrl) ? '请输入有效的图片链接。' : '');
    } finally {
      setUploading(false);
    }
  }

  return <div className="purchase-product-fields">
    {includeName && <label>商品名称<input name={`${prefix}name`} defaultValue={details ? details.name ?? '' : defaultName ?? ''} maxLength={160} /></label>}
    <label>规格<input name={`${prefix}specification`} defaultValue={details?.specification ?? ''} maxLength={1000} placeholder="型号、颜色或材质" /></label>
    <label>尺寸<input name={`${prefix}dimensions`} defaultValue={details?.dimensions ?? ''} maxLength={240} placeholder="长 × 宽 × 高，含单位" /></label>
    <label className="purchase-product-description">商品介绍
      <textarea name={`${prefix}description`} defaultValue={details?.description ?? ''} maxLength={2000} rows={3} />
    </label>
    <div className="purchase-product-image">
      <label>商品图片
        <input ref={urlInput} name={`${prefix}imageUrl`} type="text" inputMode="url" value={imageUrl} maxLength={2048} placeholder="粘贴图片链接或上传"
          onChange={(event) => {
            if (uploading) return;
            const input = event.currentTarget;
            input.setCustomValidity(input.value.trim() && !safePurchaseProductImageUrl(input.value) ? '请输入有效的 HTTP 或 HTTPS 图片链接。' : '');
            setImageUrl(input.value);
          }} />
      </label>
      <div className="product-image-actions">
        <input type="file" ref={fileInput} hidden tabIndex={-1} accept="image/jpeg,image/png,image/webp" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void uploadProductImage(file);
        }} />
        <button type="button" className="secondary-button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? '正在上传…' : '上传图片'}</button>
        <PurchaseProductImageLink value={imageUrl} />
        {imageUrl.startsWith(purchaseProductImagePath) && safePurchaseProductImageUrl(imageUrl) && <Image className="product-image-thumbnail" src={imageUrl} alt="已上传的商品图片" width={42} height={42} unoptimized />}
      </div>
      {uploadError && <small className="product-image-error" role="alert">{uploadError}</small>}
    </div>
  </div>;
}
