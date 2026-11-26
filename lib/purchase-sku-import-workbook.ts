import { unzipSync, zipSync } from 'fflate';
import readXlsxFile, { type Row, type Sheet } from 'read-excel-file/universal';
import { SaxesParser } from 'saxes';
import { purchaseProductDetailsSchema } from './contracts';
import { HttpError } from './db';

export const SKU_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const maxExpandedBytes = 12 * 1024 * 1024;
const maxWorkbookEntries = 256;
const maxRows = 500;
const preferredSheetName = '商品资料';

const headings = {
  code: ['SKU编码', 'SKU', '商品编码', '产品编码', 'ERP SKU', 'SKU CODE'],
  name: ['商品名称', '产品名称', '品名', '商品名', 'NAME', 'PRODUCT NAME'],
  specification: ['规格', '产品规格', '商品规格', 'SPECIFICATION', 'SPEC'],
  dimensions: ['尺寸', '产品尺寸', '商品尺寸', 'DIMENSIONS', 'SIZE'],
  imageUrl: ['图片链接', '图片URL', '商品图片', '主图链接', 'IMAGE URL'],
  description: ['商品介绍', '产品介绍', '商品描述', '产品描述', '介绍', 'DESCRIPTION'],
} as const;

export type SkuImportField = Exclude<keyof typeof headings, 'code'>;
export const skuImportFields = ['name', 'specification', 'dimensions', 'imageUrl', 'description'] as const;
export const skuImportFieldLabels: Record<SkuImportField, string> = {
  name: '商品名称', specification: '规格', dimensions: '尺寸', imageUrl: '图片链接', description: '商品介绍',
};

export type ImportWorkbookRow = {
  rowNumber: number;
  code: string;
  fields: Partial<Record<SkuImportField, string>>;
  errors: string[];
};

const importDetailsSchema = purchaseProductDetailsSchema.extend({
  name: purchaseProductDetailsSchema.shape.name.unwrap().unwrap().max(160).optional(),
});

export async function readSkuImportWorkbook(bytes: Uint8Array) {
  if (bytes.byteLength > SKU_IMPORT_MAX_FILE_BYTES) throw workbookError('Excel 文件不能超过 2 MB', 413);
  if (bytes.byteLength < 22 || new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) !== 0x04034b50) {
    throw workbookError('请选择有效的 .xlsx 工作簿');
  }

  let sheets: Sheet[];
  try {
    sheets = await readXlsxFile(checkedSpreadsheetArchive(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw workbookError('读取 Excel 失败，请使用 Excel 打开文件并另存为 .xlsx 后重试');
  }

  const dataSheets = sheets.filter(({ data }) => data.some(row => cellsHaveValues(row)));
  if (dataSheets.length > 1) {
    const preferred = dataSheets.find(({ sheet }) => sheet === preferredSheetName);
    const competing = dataSheets.filter(sheet => sheet !== preferred).map(({ sheet }) => sheet).join('、');
    throw workbookError(`发现多个有内容的工作表（${competing}）。请每次只保留一个有商品资料的工作表`);
  }
  const chosen = dataSheets[0];
  if (!chosen) throw workbookError('没有找到商品资料，请填写模板后重试');

  const firstNonempty = chosen.data.findIndex(row => cellsHaveValues(row));
  const columns = readHeadings(chosen.data[firstNonempty]);
  const rows: ImportWorkbookRow[] = [];
  for (let index = firstNonempty + 1; index < chosen.data.length; index++) {
    const raw = chosen.data[index];
    if (!cellsHaveValues(raw)) continue;
    if (rows.length >= maxRows) throw workbookError(`单次最多导入 ${maxRows} 行商品资料，请拆分后上传`);
    const row = readDataRow(raw, index + 1, columns);
    rows.push(row);
  }
  if (!rows.length) throw workbookError('表头下没有找到商品资料');
  return { sheetName: chosen.sheet, rows };
}

function readHeadings(header: Row) {
  const columns = new Map<keyof typeof headings, number>();
  for (const [index, value] of header.entries()) {
    const field = namedHeading(value);
    if (!field) continue;
    if (columns.has(field)) throw workbookError(`表头重复出现「${headings[field][0]}」，请保留一列`);
    columns.set(field, index);
  }
  if (!columns.has('code')) throw workbookError('表头必须包含「SKU编码」，请使用导入模板');
  return columns;
}

function readDataRow(raw: Row, rowNumber: number, columns: Map<keyof typeof headings, number>): ImportWorkbookRow {
  const rawCode = raw[columns.get('code')!];
  const normalized = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  const errors: string[] = [];
  if (typeof rawCode === 'number') errors.push('SKU 编码请使用文本格式，以保留前导零');
  else if (!normalized) errors.push('缺少 SKU 编码');
  else if (normalized.length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) errors.push('SKU 编码格式无效或超过 80 个字符');
  else if (namedHeading(rawCode) === 'code' && raw.some((cell, index) => index !== columns.get('code') && namedHeading(cell))) {
    errors.push('资料中间出现重复表头，请删除该行');
  }

  const fields: Partial<Record<SkuImportField, string>> = {};
  for (const field of skuImportFields) {
    const column = columns.get(field);
    if (column === undefined) continue;
    const value = raw[column];
    if (value == null || typeof value === 'string' && !value.trim()) continue;
    if (typeof value !== 'string' && (typeof value !== 'number' || field !== 'dimensions' && field !== 'specification')) {
      errors.push(`「${skuImportFieldLabels[field]}」请填写文本`);
      continue;
    }
    const result = importDetailsSchema.shape[field].safeParse(String(value).trim());
    if (!result.success || typeof result.data !== 'string') {
      errors.push(field === 'imageUrl' ? '图片链接无效，请使用可访问的 HTTP 或 HTTPS 链接' : `「${skuImportFieldLabels[field]}」内容过长或格式无效`);
    } else {
      fields[field] = result.data;
    }
  }
  return { rowNumber, code: normalized.slice(0, 80), fields, errors };
}

function namedHeading(value: Row[number] | undefined) {
  if (typeof value !== 'string') return;
  const normalized = value.replace(/[\s_　]+/gu, '').toUpperCase();
  return (Object.keys(headings) as Array<keyof typeof headings>).find(field => headings[field]
    .some(alias => alias.replace(/\s+/gu, '').toUpperCase() === normalized));
}

function cellsHaveValues(row: Row) {
  return row.some(value => value != null && (typeof value !== 'string' || value.trim() !== ''));
}

function checkedSpreadsheetArchive(bytes: Uint8Array) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const seen = new Set<string>();
  let expanded = 0;
  const entries = unzipSync(bytes, { filter(entry) {
    const { name, originalSize, size, compression } = entry;
    if (seen.size >= maxWorkbookEntries || seen.has(name)
      || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => ['.', '..', '__proto__'].includes(part))) {
      throw workbookError('工作簿文件结构无效或包含过多内容');
    }
    seen.add(name);
    if (/^xl\/(?:media\/|embeddings\/|vbaProject\.bin$)/iu.test(name)) {
      throw workbookError('请将嵌入图片改为图片链接，或导入后逐个上传商品图片');
    }
    if (!name.endsWith('.xml') && !name.endsWith('.xml.rels')) return false;
    expanded += originalSize;
    if (expanded > maxExpandedBytes || compression === 0 && originalSize !== size || size > bytes.byteLength) {
      throw workbookError('工作簿展开后的内容过大或损坏，请拆分后上传');
    }
    return true;
  } });

  let totalCells = 0;
  for (const content of Object.values(entries)) {
    totalCells += validateSpreadsheetXml(decoder.decode(content));
    if (totalCells > 200_000) throw workbookError('工作簿的单元格区域过大，请移除多余空白行列');
  }
  // A stored archive avoids spawning Worker threads in the XLSX reader on server runtimes.
  return zipSync(entries, { level: 0 });
}

function validateSpreadsheetXml(xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  let worksheet: boolean | undefined;
  let lastRow = 0;
  let lastColumn = 0;
  parser.on('doctype', () => { throw workbookError('工作簿包含不支持的 XML 声明'); });
  parser.on('opentag', ({ local, attributes }) => {
    worksheet ??= local === 'worksheet';
    if (!worksheet) return;
    if (local === 'f') throw workbookError('导入工作表包含公式，请粘贴为数值或文本后重试');
    const address = attributes.r?.value;
    if (local === 'row') {
      const row = address ? Number(address) : lastRow + 1;
      if (!Number.isSafeInteger(row) || row < 1 || row > 2000) {
        throw workbookError('请删除超过第 2000 行的单元格或留空格式后重试');
      }
      lastRow = Math.max(lastRow, row);
    }
    if (local === 'c') {
      const match = /^([A-Z]{1,2})([1-9]\d{0,3})$/u.exec(address ?? '');
      const column = match ? [...match[1]].reduce((position, letter) => 26 * position + letter.charCodeAt(0) - 64, 0) : 0;
      if (!match || Number(match[2]) > 2000 || column > 64) throw workbookError('请删除超出 A1:BL2000 区域的单元格');
      lastColumn = Math.max(lastColumn, column);
      lastRow = Math.max(lastRow, Number(match[2]));
    }
  });
  parser.write(xml).close();
  return lastRow * lastColumn;
}

function workbookError(message: string, status = 400) {
  return new HttpError(status, message, 'INVALID_SKU_IMPORT_WORKBOOK');
}
