import { strToU8, zipSync } from 'fflate';
import { skuCatalogFields, type SkuCatalogEntry } from './purchase-sku-catalog';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationship = 'http://schemas.openxmlformats.org/package/2006/relationships';

export function writeSkuCompletionWorkbook(skus: SkuCatalogEntry[]) {
  const headers = ['SKU编码', '当前商品名称', '待补资料', '商品名称', '规格', '尺寸', '图片链接', '商品介绍'];
  // Export blank editable fields so an older workbook cannot overwrite updated master data by default.
  const rows = [headers, ...skus.map(sku => [
    sku.code, sku.name, sku.missingFields.map(field => skuCatalogFields[field]).join('、'),
  ])];
  const cells = rows.map((columns, index) => {
    const row = index + 1;
    return `<row r="${row}">${columns.map((value, column) => {
      const address = `${String.fromCharCode(65 + column)}${row}`;
      return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('')}</row>`;
  }).join('');
  const parts = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageRelationship}">
      <Relationship Id="rId1" Type="${officeRelationship}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationship}">
      <bookViews><workbookView/></bookViews>
      <sheets><sheet name="商品资料" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRelationship}">
      <Relationship Id="rId1" Type="${officeRelationship}/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheetNamespace}">
      <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
      <cols><col min="1" max="8" width="24" customWidth="1"/></cols>
      <sheetData>${cells}</sheetData>
      <autoFilter ref="A1:H${rows.length}"/>
    </worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)])));
}

function escapeXml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '\ufffd');
}
