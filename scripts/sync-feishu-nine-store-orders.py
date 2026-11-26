"""Read the four approved order Base tables and write one verified nine-store snapshot."""

import argparse
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import re
from runpy import run_path
import subprocess
import tempfile


STORES = (
    ("amazon-senyu", "amazon", "森语", ("Amazon_senyu",)),
    ("amazon-kaguyasu", "amazon", "Kaguyasu", ("Amazon_kagu",)),
    ("amazon-zhongcheng", "amazon", "中诚", ("Amazon_zhongcheng",)),
    ("amazon-genji", "amazon", "Genji", ("Amazon_genji",)),
    ("shopify-anzhap", "shopify", "Anzhap", ("Shopify_anz",)),
    ("shopify-zimasya", "shopify", "Zimasya", ("Shopify_zim", "Shopify_zima")),
    ("shopify-kaguyasu", "shopify", "Kaguyasu", ("Shopify_kagu",)),
    ("shopify-bizfurniz", "shopify", "BizFurniz", ("Shopify_Biz",)),
    ("wayfair-linhe", "wayfair", "林和", ("Wayfair_linhe",)),
)
STORE_BY_ALIAS = {alias: (key, platform) for key, platform, _, aliases in STORES for alias in aliases}
ORDER_FIELDS = {
    "store": ("店铺", "select"), "orderNo": ("订单号", "text"), "sku": ("SKU(店铺)", "text"),
    "date": ("日期", "datetime"), "quantity": ("销量", "number"),
}
SHIPMENT_FIELD = {"shipped": ("是否发货", "select")}
PROJECTIONS = {
    "amazon-orders": {**ORDER_FIELDS, **SHIPMENT_FIELD},
    "shopify-orders": {**ORDER_FIELDS, "cancelled": ("是否取消", "select")},
    "wayfair-orders": {**ORDER_FIELDS, **SHIPMENT_FIELD},
    "refunds": {"store": ("店铺", "select"), "orderNo": ("订单号", "text"),
                "sku": ("sku", "text"), "date": ("退款完成日期", "datetime")},
}
PAGE_SIZE = 2_000


class CollectionError(Exception):
    pass


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def matches(value, expression):
    return isinstance(value, str) and re.fullmatch(expression, value)


def load_config(path):
    config = load_json(path)
    if (not isinstance(config, dict) or set(config) != {"version", "profile", "identity", "baseToken", "tables"}
            or config["version"] != 1 or config["identity"] not in ("user", "bot")
            or not matches(config["profile"], r"[A-Za-z0-9_.-]{1,120}")
            or not matches(config["baseToken"], r"[A-Za-z0-9_-]{8,100}")
            or not isinstance(config["tables"], dict) or set(config["tables"]) != set(PROJECTIONS)):
        raise CollectionError("NINE_STORE_CONFIG_INVALID")
    ids = set()
    for kind, fields in PROJECTIONS.items():
        table = config["tables"][kind]
        if (not isinstance(table, dict) or set(table) != {"id", "fields"}
                or not matches(table["id"], r"tbl[A-Za-z0-9]{6,100}")
                or table["id"] in ids or not isinstance(table["fields"], dict)
                or set(table["fields"]) != set(fields)
                or not all(matches(value, r"fld[A-Za-z0-9]{4,100}") for value in table["fields"].values())
                or len(set(table["fields"].values())) != len(fields)):
            raise CollectionError("NINE_STORE_CONFIG_INVALID")
        ids.add(table["id"])
    return config


def call_lark(cli, action, *arguments, cwd=None):
    args = [*cli.command, "--profile", cli.profile, "base", action, *arguments, "--as", cli.identity]
    env = {**os.environ, "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1"}
    env.pop("ERP_FEISHU_SYNC_WORKER_TOKEN", None)
    env.pop("ERP_NINE_STORE_ORDER_WORKER_TOKEN", None)
    try:
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, check=False, encoding="utf-8", timeout=80,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise CollectionError("NINE_STORE_LARK_TIMEOUT") from None
    except (OSError, UnicodeError):
        raise CollectionError("NINE_STORE_LARK_READ_FAILED") from None
    if result.returncode:
        try:
            error = json.loads(result.stderr).get("error", {})
        except (AttributeError, json.JSONDecodeError):
            error = {}
        if isinstance(error, dict) and (error.get("type") in {"authorization", "authentication"} or error.get("missing_scopes")):
            raise CollectionError("NINE_STORE_LARK_AUTHORIZATION_FAILED") from None
        raise CollectionError("NINE_STORE_LARK_READ_FAILED") from None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise CollectionError("NINE_STORE_LARK_OUTPUT_INVALID") from None


def table_directory(cli, config):
    reply = call_lark(cli, "+table-list", "--base-token", config["baseToken"], "--format", "json")
    if not isinstance(reply, dict) or reply.get("ok") is not True or reply.get("identity") != cli.identity:
        raise CollectionError("NINE_STORE_BASE_DIRECTORY_UNVERIFIED")
    data = reply.get("data")
    tables = data.get("tables") if isinstance(data, dict) else None
    if not isinstance(tables, list) or data.get("has_more") is True or data.get("total") != len(tables):
        raise CollectionError("NINE_STORE_BASE_DIRECTORY_UNVERIFIED")
    target_ids = {entry["id"] for entry in config["tables"].values()}
    directory = {}
    for table in tables:
        if isinstance(table, dict) and table.get("id") in target_ids:
            revision, count, table_id = table.get("rev"), table.get("records_count"), table["id"]
            if table_id in directory or type(revision) is not int or revision < 0 or type(count) is not int or count < 0:
                raise CollectionError("NINE_STORE_BASE_DIRECTORY_UNVERIFIED")
            directory[table_id] = (revision, count)
    if set(directory) != target_ids:
        raise CollectionError("NINE_STORE_SOURCE_TABLE_MISSING")
    return directory


def checked_manifest(reply, file, config, kind, table, revision, total, offset):
    manifest = load_json(file.with_suffix(".manifest.json"))
    if (not isinstance(manifest, dict) or manifest != reply or manifest.get("manifest_version") != "v1"
            or manifest.get("format") != "ndjson" or manifest.get("base_token") != config["baseToken"]
            or manifest.get("table_id") != table["id"] or manifest.get("timezone") != "Asia/Shanghai"
            or manifest.get("query_context") != {"field_scope": "selected_fields", "record_scope": "all_records"}
            or manifest.get("requested_limit") != PAGE_SIZE or manifest.get("page_count") != 1
            or manifest.get("record_file_size_bytes") != file.stat().st_size):
        raise CollectionError("NINE_STORE_PAGE_MANIFEST_INVALID")
    if manifest.get("rev") != revision:
        raise CollectionError("NINE_STORE_SOURCE_REVISION_CHANGED")
    count = manifest.get("records_count")
    more = manifest.get("has_more")
    if (type(count) is not int or not 0 <= count <= PAGE_SIZE or type(more) is not bool or offset + count > total
            or more != (offset + count < total) or (more and (not count or manifest.get("next_offset") != offset + count))
            or (not more and manifest.get("next_offset") not in (None, offset + count))):
        raise CollectionError("NINE_STORE_PAGE_OFFSET_INVALID")
    columns = manifest.get("columns")
    projection = PROJECTIONS[kind]
    if not isinstance(columns, dict) or set(columns) != {"record_id", *(name for name, _ in projection.values())}:
        raise CollectionError("NINE_STORE_FIELD_PROJECTION_CHANGED")
    for field, (name, type_) in projection.items():
        column = columns[name]
        if not isinstance(column, dict) or column.get("field_id") != table["fields"][field] or column.get("field_type") != type_:
            raise CollectionError("NINE_STORE_FIELD_PROJECTION_CHANGED")
    return count, more, set(columns)


def select_value(value):
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], str):
        return value[0].strip() or None
    return None


def text_value(value, limit):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= limit and not re.search(r"[\x00-\x1f\x7f]", value) else None


def date_value(value):
    if not isinstance(value, str):
        return None
    try:
        if len(value) == 10:
            return date.fromisoformat(value).isoformat()
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return timestamp.date().isoformat() if timestamp.tzinfo is not None else None
    except ValueError:
        return None


def normalize_record(record, kind, record_id):
    projection = PROJECTIONS[kind]
    fields = {field: record.get(name) for field, (name, _) in projection.items()}
    alias = select_value(fields["store"])
    if not alias:
        return "invalid", None
    store = STORE_BY_ALIAS.get(alias)
    if not store or (kind != "refunds" and kind != f"{store[1]}-orders"):
        return "outsideScope", None
    order_no = text_value(fields["orderNo"], 90)
    if not matches(order_no, r"[A-Za-z0-9#_.-][A-Za-z0-9#_. -]{2,89}"):
        return "invalid", None
    sku = text_value(fields["sku"], 120)
    item = {"recordId": record_id, "storeKey": store[0], "orderNo": order_no, "sku": None if sku and "@" in sku else sku}
    if kind == "refunds":
        return "accepted", {**item, "refundDate": date_value(fields["date"])}
    quantity = fields["quantity"]
    confirmed_quantity = int(quantity) if type(quantity) in (int, float) and 0 <= quantity <= 1_000_000 and quantity == int(quantity) else None
    fulfillment = {"是": "shipped", "否": "pending"}.get(select_value(fields.get("shipped")))
    if select_value(fields.get("cancelled")) == "是":
        fulfillment = "cancelled"
    return "accepted", {**item, "orderDate": date_value(fields["date"]), "quantity": confirmed_quantity, "fulfillment": fulfillment}


def read_table(cli, config, kind, table, directory, folder):
    revision, total = directory[table["id"]]
    counts = {"kind": kind, "revision": str(revision), "read": 0, "accepted": 0, "outsideScope": 0, "invalid": 0}
    records, seen = [], set()
    fields = [argument for name in PROJECTIONS[kind] for argument in ("--field-id", table["fields"][name])]
    offset = 0
    while True:
        file = folder / f"{kind}-{offset}.ndjson"
        reply = call_lark(cli, "+record-list", "--base-token", config["baseToken"], "--table-id", table["id"], *fields,
                          "--offset", str(offset), "--limit", str(PAGE_SIZE), "--format", "ndjson", "--output", file.name, cwd=folder)
        count, more, columns = checked_manifest(reply, file, config, kind, table, revision, total, offset)
        actual = 0
        with file.open(encoding="utf-8-sig") as stream:
            for line in stream:
                row = json.loads(line)
                if not isinstance(row, dict) or set(row) != columns or not matches(row.get("record_id"), r"rec[A-Za-z0-9]{3,80}"):
                    raise CollectionError("NINE_STORE_ROW_PROJECTION_INVALID")
                record_id = row["record_id"]
                if record_id in seen:
                    raise CollectionError("NINE_STORE_RECORD_DUPLICATED")
                seen.add(record_id)
                actual += 1
                status, item = normalize_record(row, kind, record_id)
                counts[status] += 1
                if item is not None:
                    records.append(item)
        if actual != count:
            raise CollectionError("NINE_STORE_PAGE_COUNT_MISMATCH")
        counts["read"] += actual
        if not more:
            return counts, records
        offset = reply["next_offset"]


def collect(config, folder):
    module = run_path(str(Path(__file__).with_name("sync-feishu-procurement-snapshot.py")))
    try:
        cli = module["LarkCli"](config["profile"], config["identity"])
    except module["SourceError"]:
        raise CollectionError("NINE_STORE_LARK_CLI_UNAVAILABLE") from None
    directory = table_directory(cli, config)
    orders, refunds, tables = [], [], []
    for kind in PROJECTIONS:
        counts, rows = read_table(cli, config, kind, config["tables"][kind], directory, folder)
        (refunds if kind == "refunds" else orders).extend(rows)
        tables.append(counts)
    if table_directory(cli, config) != directory:
        raise CollectionError("NINE_STORE_SOURCE_REVISION_CHANGED")
    return {
        "version": 1, "source": "feishu-order-base", "observedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "stores": [{"key": key, "platform": platform, "name": name} for key, platform, name, _ in STORES],
        "tables": tables, "orders": orders, "refunds": refunds,
    }


def save_snapshot(snapshot, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".nine-orders-", dir=output.parent, delete=False) as stream:
        pending = Path(stream.name)
        try:
            json.dump(snapshot, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            pending.unlink(missing_ok=True)
            raise
    try:
        os.replace(pending, output)
    finally:
        pending.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        with tempfile.TemporaryDirectory(prefix="yicang-nine-orders-") as directory:
            snapshot = collect(config, Path(directory))
        save_snapshot(snapshot, args.output)
        print(json.dumps({"ok": True, "observedAt": snapshot["observedAt"], "stores": len(snapshot["stores"]),
                          "tables": snapshot["tables"], "orders": len(snapshot["orders"]), "refunds": len(snapshot["refunds"])}))
    except CollectionError as error:
        print(json.dumps({"ok": False, "code": str(error)}))
        return 1
    except (OSError, UnicodeError, ValueError):
        print(json.dumps({"ok": False, "code": "NINE_STORE_FILE_OR_DATA_INVALID"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
