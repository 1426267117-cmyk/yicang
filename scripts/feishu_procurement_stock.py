"""Collect complete Feishu warehouse and transit inputs without writing to Feishu."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import re

from feishu_procurement_assemble import code, WAREHOUSES
from feishu_procurement_sales import SourceError, Spreadsheet, iso_date, whole_number


WAREHOUSE_COLUMNS = ("sku", "在仓库存", "在仓预留", "在途库存", "在途预留", "退回入库", "销毁", "可用库存")
STOCK_TOTAL_COLUMNS = ("今日库存", "", "在仓库存", "在仓预留", "在途库存", "在途预留",
                       "退回入库", "历史总销毁", "可用库存")
SAFE_SHIPMENT = re.compile(r"https?://|\b1Z[A-Z0-9]{14,}\b|\d{8,}|@|[\r\n]", re.IGNORECASE)


def collect_stock(cli, config):
    book = Spreadsheet(cli, config)
    by_region = config["worksheets"]
    if set(by_region) != set(WAREHOUSES):
        raise SourceError("STOCK_SCOPE_MUST_BE_CA_GA_NJ")

    def read_region(warehouse):
        rows = book.full(by_region[warehouse], "H", rows_per_read=4000)
        if rows.pop(1, ()) != WAREHOUSE_COLUMNS:
            raise SourceError("STOCK_COLUMNS_CHANGED")
        codes = set()
        result = []
        totals = Counter()
        for row in rows.values():
            if not any(row):
                continue
            sku = code(row[0])
            quantities = [whole_number(value) for value in row[1:]]
            if not sku and len(quantities) == 7 and set(quantities) == {0}:
                continue
            if not sku or sku in codes or len(quantities) != 7 or any(number is None for number in quantities):
                raise SourceError("STOCK_ROW_MISSING_OR_DUPLICATE")
            codes.add(sku)
            totals.update({index: value for index, value in enumerate(quantities)})
            result.append((warehouse, sku, quantities[-1]))
        if not result:
            raise SourceError("STOCK_WORKSHEET_EMPTY")
        return result, totals

    with ThreadPoolExecutor(max_workers=3) as pool:
        region_rows = dict(zip(WAREHOUSES, pool.map(read_region, WAREHOUSES)))
    summary_titles = [name for name, sheet in book.sheets.items() if sheet["sheet_id"] == config["summarySheetId"]]
    if len(summary_titles) != 1:
        raise SourceError("STOCK_SUMMARY_SHEET_MISSING")
    summary = book.rows(summary_titles[0], "B2:J6")
    if summary.pop(2, ()) != STOCK_TOTAL_COLUMNS:
        raise SourceError("STOCK_SUMMARY_COLUMNS_CHANGED")
    all_totals = [sum(region_rows[region][1][index] for region in WAREHOUSES) for index in range(7)]
    found = set()
    for row in summary.values():
        if len(row) != 9:
            raise SourceError("STOCK_SUMMARY_MALFORMED")
        warehouse = row[1]
        if warehouse in found or warehouse not in {*WAREHOUSES, "总库存"}:
            raise SourceError("STOCK_SUMMARY_SCOPE_MISMATCH")
        found.add(warehouse)
        expected = all_totals if warehouse == "总库存" else [region_rows[warehouse][1][index] for index in range(7)]
        if [whole_number(item) for item in row[2:]] != expected:
            raise SourceError("STOCK_TOTAL_RECONCILIATION_FAILED")
    if found != {*WAREHOUSES, "总库存"}:
        raise SourceError("STOCK_SUMMARY_COVERAGE_INCOMPLETE")
    book.verify_revision()
    return [record for region in WAREHOUSES for record in region_rows[region][0]], book.revision


def collect_shared_inventory(cli, config):
    book = Spreadsheet(cli, config)
    title = config["sheet"]
    rows = book.full(title, "A")
    if rows.pop(1, ()) != ("SKU",):
        raise SourceError("SHARED_STOCK_COLUMNS_CHANGED")
    results = {}
    for number, row in sorted(rows.items()):
        sku = code(row[0]) if row else ""
        if sku and sku not in results:
            results[sku] = number
    if not results:
        raise SourceError("SHARED_STOCK_RULES_EMPTY")
    book.verify_revision()
    return results, book.revision


def plain(value, error):
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        if not value:
            return ""
        if len(value) == 1:
            return plain(value[0], error)
    if isinstance(value, dict):
        for field in ("text", "name", "value"):
            if field in value:
                return plain(value[field], error)
    if value is None:
        return ""
    raise SourceError(error)


def transit_date(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = value / 1000 if abs(value) >= 10**12 else value
        try:
            return datetime.fromtimestamp(number, timezone(timedelta(hours=8))).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    text = plain(value, "TRANSIT_DATE_MALFORMED")
    direct = iso_date(text)
    if direct is not None:
        return direct
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo:
        moment = moment.astimezone(timezone(timedelta(hours=8)))
    return moment.date().isoformat()


TRANSIT_FIELDS = {
    "sku": "SKU", "batch": "备货批次", "shelved": "实际到仓上架时间", "pcs": "数量(PCS)",
    "container": "柜子编号(公司内)", "region": "目的港", "status": "运输状态", "arrival": "预计到仓时间",
}


def collect_transit(cli, config):
    fields = config["fields"]
    if not all(label in fields for label in TRANSIT_FIELDS.values()):
        raise SourceError("TRANSIT_REQUIRED_COLUMNS_MISSING")
    common = ["--base-token", config["baseToken"], "--table-id", config["tableId"]]
    for name in TRANSIT_FIELDS.values():
        common.extend(("--field-id", fields[name]))
    offset = 0
    revision = None
    seen = set()
    transit = []
    total = 0
    while True:
        page = cli("base", "+record-list", *common, "--limit", "200", "--offset", str(offset))
        matrix = page.get("data")
        row_ids = page.get("record_id_list")
        labels = page.get("fields")
        current_revision = page.get("rev")
        if (not isinstance(matrix, list) or not isinstance(row_ids, list) or len(matrix) != len(row_ids)
                or not isinstance(labels, list) or set(labels) != set(TRANSIT_FIELDS.values())
                or not isinstance(current_revision, int) or page.get("query_context", {}).get("record_scope") != "all_records"):
            raise SourceError("TRANSIT_PAGE_INCOMPLETE")
        if revision is None:
            revision = current_revision
        if current_revision != revision:
            raise SourceError("TRANSIT_REVISION_CHANGED")
        positions = {key: labels.index(label) for key, label in TRANSIT_FIELDS.items()}
        for row_id, record in zip(row_ids, matrix):
            if not row_id or row_id in seen or not isinstance(record, list) or len(record) != len(labels):
                raise SourceError("TRANSIT_PAGE_ROW_DUPLICATE_OR_INVALID")
            seen.add(row_id)
            fields_row = {key: record[index] for key, index in positions.items()}
            status = plain(fields_row["status"], "TRANSIT_STATUS_INVALID")
            if status not in config["landedStatuses"] and status not in config["shippingStatuses"]:
                raise SourceError("TRANSIT_STATUS_UNRECOGNIZED")
            if status not in config["shippingStatuses"] or fields_row["shelved"] not in (None, "", []):
                continue
            sku = code(plain(fields_row["sku"], "TRANSIT_SKU_INVALID"))
            region = plain(fields_row["region"], "TRANSIT_REGION_INVALID")
            pcs = whole_number(fields_row["pcs"])
            arrival = transit_date(fields_row["arrival"])
            batch = plain(fields_row["batch"], "TRANSIT_BATCH_INVALID")
            container = plain(fields_row["container"], "TRANSIT_CONTAINER_INVALID")
            if not sku or region not in config["regions"] or pcs is None or pcs <= 0 or arrival is None:
                raise SourceError("TRANSIT_ELIGIBLE_ROW_INCOMPLETE")
            if SAFE_SHIPMENT.search(batch) or SAFE_SHIPMENT.search(container):
                raise SourceError("TRANSIT_EXTERNAL_IDENTIFIER_REJECTED")
            transit.append({"sku": sku, "region": region, "arrivalDate": arrival, "pcs": pcs,
                            "batch": batch or None, "container": container or None})
        total += len(matrix)
        if page.get("has_more") is False:
            break
        next_offset = page.get("next_offset", offset + len(matrix))
        if page.get("has_more") is not True or not matrix or next_offset != offset + len(matrix):
            raise SourceError("TRANSIT_PAGINATION_INVALID")
        offset = next_offset
    if not total:
        raise SourceError("TRANSIT_SOURCE_EMPTY")
    if cli("base", "+record-list", *common, "--limit", "1", "--offset", "0").get("rev") != revision:
        raise SourceError("TRANSIT_REVISION_CHANGED")
    return transit, revision, total
