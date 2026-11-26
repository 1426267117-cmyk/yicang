"""Read configured Feishu catalogs and bounded ERP previews without editing sources."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
from io import StringIO
import json
import math
from pathlib import Path
import re
from runpy import run_path

from feishu_procurement_sales import ROW_PREFIX, SourceError, whole_number
from feishu_procurement_stock import transit_date


IDENTIFIER = re.compile(r"[A-Za-z0-9_.-]{1,128}")
A_RANGE = re.compile(r"A([1-9]\d{0,5}):([A-Z]{1,3})([1-9]\d{0,5})")
PRIVATE_COLUMN = re.compile(
    r"收件|客户姓名|联系人|姓名|手机|电话|地址|邮编|运单号|物流单号|追踪号|跟踪号|订单号|订单编号|提单号|柜号|备注|"
    r"tracking|recipient|consignee|customer\s*name|address|email|phone|order[ _-]*(?:id|no\b|number)|container[ _-]*(?:id|no\b|number)",
    re.IGNORECASE,
)
PRIVATE_VALUE = re.compile(
    r"https?://|www\.|@|\d{8,}|\b1Z[A-Z0-9]{14,}\b|\d{3}[- .]\d{3,4}[- .]\d{4}|"
    r"\b\d{3}[- ]\d{7}[- ]\d{7}\b|[\r\n]",
    re.IGNORECASE,
)
DATE_COLUMN = re.compile(r"日期|时间|预计到仓|上架|\b(?:date|time|arrival)\b", re.IGNORECASE)
MAX_ROWS = 25


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def text(value):
    return value.strip() if isinstance(value, str) else ""


def safe_label(value):
    label = text(value)
    if not label or len(label) > 120 or PRIVATE_COLUMN.search(label):
        raise SourceError("PREVIEW_COLUMN_NOT_ALLOWED")
    return label


def validate_sources(config):
    sources = config["sources"]
    if not isinstance(sources, list) or not 1 <= len(sources) <= 30:
        raise SourceError("PREVIEW_CONFIG_INVALID")
    ids = set()
    for source in sources:
        if not isinstance(source, dict) or not IDENTIFIER.fullmatch(text(source.get("id"))) or source["id"] in ids:
            raise SourceError("PREVIEW_CONFIG_INVALID")
        if (not text(source.get("title")) or source.get("type") not in ("sheet", "bitable")
                or source.get("usage") not in ("采购", "库存", "物流", "订单")
                or not IDENTIFIER.fullmatch(text(source.get("token"))) or not isinstance(source.get("previews"), dict)):
            raise SourceError("PREVIEW_CONFIG_INVALID")
        ids.add(source["id"])
    return sources


def sheet_meta(cli, source):
    data = cli("sheets", "+workbook-info", "--spreadsheet-token", source["token"])
    if not isinstance(data.get("sheets"), list) or type(data.get("revision")) is not int:
        raise SourceError("PREVIEW_METADATA_INVALID")
    return data


def base_tables(cli, source):
    data = cli("base", "+table-list", "--base-token", source["token"])
    records = next((data[k] for k in ("tables", "items", "data") if isinstance(data.get(k), list)), None)
    if records is None or data.get("has_more") is True or data.get("total", len(records)) != len(records):
        raise SourceError("PREVIEW_METADATA_INVALID")
    return records


def declared_tables(source, records):
    results = []
    ids = set()
    for row in records:
        if not isinstance(row, dict):
            raise SourceError("PREVIEW_METADATA_INVALID")
        is_sheet = source["type"] == "sheet"
        key = row.get("sheet_id") if is_sheet else row.get("table_id", row.get("id"))
        name = (row.get("sheet_name") or row.get("title")) if is_sheet else (row.get("name") or row.get("title"))
        if not IDENTIFIER.fullmatch(text(key)) or key in ids or not text(name):
            raise SourceError("PREVIEW_METADATA_INVALID")
        available = key in source["previews"] and (not is_sheet or row.get("resource_type") == "sheet")
        results.append({"id": key, "title": name, "hidden": bool(row.get("is_hidden")), "preview": available})
        ids.add(key)
    return results


def catalog_source(cli, source):
    descriptor = {k: source[k] for k in ("id", "title", "type", "usage")}
    try:
        if source["type"] == "sheet":
            meta = sheet_meta(cli, source)
            tables = declared_tables(source, meta["sheets"])
            descriptor["title"] = text(meta.get("title")) or descriptor["title"]
        else:
            tables = declared_tables(source, base_tables(cli, source))
    except SourceError:
        return {**descriptor, "status": "failed", "checkedAt": None, "tables": [],
                "message": "飞书来源读取失败，请检查访问权限或稍后刷新。"}
    return {**descriptor, "status": "ready", "checkedAt": now(), "tables": tables}


def cell(value, label):
    if isinstance(value, list):
        if len(value) != 1:
            return None
        return cell(value[0], label)
    if isinstance(value, dict):
        for key in ("text", "name", "value"):
            if key in value:
                return cell(value[key], label)
        return None
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        if abs(value) >= 10**9 and DATE_COLUMN.search(label):
            return transit_date(value)
        return value if abs(value) < 10**8 else None
    value = text(value)
    if not value or len(value) > 72 or PRIVATE_VALUE.search(value):
        return None
    if "sku" not in label.lower():
        integer = whole_number(value)
        if integer is not None:
            return integer if abs(integer) < 10**8 else None
    return value


def sheet_rows(data, region, revision, start, end):
    if data.get("revision") != revision:
        raise SourceError("PREVIEW_SOURCE_CHANGED")
    if data.get("has_more") is not False or data.get("actual_range") != region:
        raise SourceError("PREVIEW_RANGE_INCOMPLETE")
    annotated = data.get("annotated_csv")
    if not isinstance(annotated, str):
        raise SourceError("PREVIEW_RANGE_INCOMPLETE")
    parsed = {}
    for record in csv.reader(StringIO(ROW_PREFIX.sub(lambda match: match[1] + ",", annotated))):
        if not record:
            continue
        if not record[0].isdigit():
            raise SourceError("PREVIEW_RANGE_INCOMPLETE")
        number = int(record[0])
        if number < start or number > end or number in parsed:
            raise SourceError("PREVIEW_RANGE_INCOMPLETE")
        parsed[number] = record[1:]
    return parsed


def sheet_preview(cli, source, table_id, projection):
    region = text(projection.get("range"))
    bounds = A_RANGE.fullmatch(region)
    if not bounds:
        raise SourceError("PREVIEW_CONFIG_INVALID")
    start, end = int(bounds[1]), int(bounds[3])
    width = 0
    for letter in bounds[2]:
        width = width * 26 + ord(letter) - ord("A") + 1
    header = projection.get("headerRow")
    if not 1 <= width <= 128 or type(header) is not int or not start <= header < end or end - start > 299:
        raise SourceError("PREVIEW_CONFIG_INVALID")
    configured = projection.get("columns")
    if not isinstance(configured, list) or not 1 <= len(configured) <= 20:
        raise SourceError("PREVIEW_CONFIG_INVALID")
    columns = []
    for entry in configured:
        if not isinstance(entry, dict) or type((index := entry.get("index"))) is not int or not 0 <= index < width:
            raise SourceError("PREVIEW_CONFIG_INVALID")
        safe_label(entry.get("header"))
        columns.append((index, entry["header"], safe_label(entry.get("label"))))
    if len({item[0] for item in columns}) != len(columns):
        raise SourceError("PREVIEW_CONFIG_INVALID")
    meta = sheet_meta(cli, source)
    table = next((t for t in declared_tables(source, meta["sheets"]) if t["id"] == table_id), None)
    if not table or not table["preview"]:
        raise SourceError("PREVIEW_TABLE_UNAVAILABLE")
    values = cli("sheets", "+csv-get", "--spreadsheet-token", source["token"], "--sheet-id", table_id, "--range", region)
    rows = sheet_rows(values, region, meta["revision"], start, end)
    actual = rows.pop(header, [])
    if any(index >= len(actual) or actual[index] != expected for index, expected, _ in columns):
        raise SourceError("PREVIEW_HEADER_CHANGED")

    labels = [label for _, _, label in columns]
    projected = []
    for number, raw in sorted(rows.items()):
        if number > header:
            selected = [cell(raw[index], label) if index < len(raw) else None for index, _, label in columns]
            if any(value is not None for value in selected):
                projected.append(selected)
    return table["title"], labels, projected[:MAX_ROWS], len(projected) > MAX_ROWS


def base_preview(cli, source, table_id, projection):
    fields = projection.get("fields")
    if not isinstance(fields, list) or not 1 <= len(fields) <= 20:
        raise SourceError("PREVIEW_CONFIG_INVALID")
    labels = []
    ids = []
    for entry in fields:
        if not isinstance(entry, dict) or not IDENTIFIER.fullmatch(text(entry.get("id"))):
            raise SourceError("PREVIEW_CONFIG_INVALID")
        ids.append(entry["id"])
        labels.append(safe_label(entry.get("label")))
    if len(set(ids)) != len(ids):
        raise SourceError("PREVIEW_CONFIG_INVALID")
    table = next((t for t in declared_tables(source, base_tables(cli, source)) if t["id"] == table_id), None)
    if not table or not table["preview"]:
        raise SourceError("PREVIEW_TABLE_UNAVAILABLE")
    arguments = ["--base-token", source["token"], "--table-id", table_id, "--limit", str(MAX_ROWS + 1)]
    for field_id in ids:
        arguments.extend(("--field-id", field_id))
    sort_field = projection.get("sortField")
    if sort_field is not None:
        if sort_field not in ids and sort_field not in labels:
            raise SourceError("PREVIEW_CONFIG_INVALID")
        arguments.extend(("--sort-json", json.dumps([{"field": sort_field, "desc": True}])))
    result = cli("base", "+record-list", *arguments)
    matrix, actual_ids, names = result.get("data"), result.get("field_id_list"), result.get("fields")
    if (not isinstance(matrix, list) or not isinstance(actual_ids, list) or not isinstance(names, list)
            or len(actual_ids) != len(names) or set(actual_ids) != set(ids) or type(result.get("has_more")) is not bool):
        raise SourceError("PREVIEW_HEADER_CHANGED")
    for name in names:
        safe_label(name)
    positions = [actual_ids.index(field_id) for field_id in ids]
    projected = []
    for record in matrix:
        if not isinstance(record, list) or len(record) != len(actual_ids):
            raise SourceError("PREVIEW_RANGE_INCOMPLETE")
        selected = [cell(record[position], label) for position, label in zip(positions, labels)]
        if any(value is not None for value in selected):
            projected.append(selected)
    return table["title"], labels, projected[:MAX_ROWS], len(projected) > MAX_ROWS or result["has_more"]


ERRORS = {
    "PREVIEW_CONFIG_INVALID": "飞书预览配置无效。",
    "PREVIEW_TABLE_UNAVAILABLE": "该子表暂未配置内容预览。",
    "PREVIEW_COLUMN_NOT_ALLOWED": "此字段不在允许的预览范围。",
    "PREVIEW_HEADER_CHANGED": "来源表头发生变化，已停止预览。",
    "PREVIEW_SOURCE_CHANGED": "读取期间来源更新，请刷新后再试。",
    "PREVIEW_RANGE_INCOMPLETE": "飞书返回的读取范围不完整，请稍后重试。",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--source")
    parser.add_argument("--table")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8-sig"))
        sources = validate_sources(config)
        lark_cli = run_path(str(Path(__file__).with_name("sync-feishu-procurement-snapshot.py")))["LarkCli"]
        cli = lark_cli(config["profile"])
        if args.table is None and args.source is None:
            with ThreadPoolExecutor(max_workers=5) as pool:
                result = {"ok": True, "sources": list(pool.map(lambda source: catalog_source(cli, source), sources))}
        else:
            source = next((s for s in sources if s["id"] == args.source), None)
            projection = source["previews"].get(args.table) if source else None
            if not isinstance(projection, dict):
                raise SourceError("PREVIEW_TABLE_UNAVAILABLE")
            preview = sheet_preview if source["type"] == "sheet" else base_preview
            title, columns, rows, has_more = preview(cli, source, args.table, projection)
            result = {"ok": True, "preview": {"sourceId": args.source, "tableId": args.table, "title": title,
                      "readAt": now(), "columns": columns, "rows": rows, "hasMore": has_more}}
    except (SourceError, KeyError, TypeError, ValueError, OSError, csv.Error) as error:
        code = str(error) if isinstance(error, SourceError) else "PREVIEW_CONFIG_INVALID"
        if code not in ERRORS:
            code = "PREVIEW_READ_FAILED"
        result = {"ok": False, "code": code, "message": ERRORS.get(code, "飞书读取失败，请检查权限或稍后重试。")}
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()
