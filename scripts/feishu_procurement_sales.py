"""Read and validate Feishu sales for a rolling 30-day procurement window."""

from collections import Counter, defaultdict
from csv import reader
from datetime import date, datetime
from decimal import Decimal
from io import StringIO
import re


class SourceError(RuntimeError):
    """A source cannot be used safely in this refresh."""


DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
ROW_PREFIX = re.compile(r"^\[row=(\d+)\] ?", re.MULTILINE)
HISTORY = "历史销售明细"
STATUS = "每日九店状态"
ORDER = "订单来源明细"
HEADERS = {
    HISTORY: ("日期", "平台", "店铺", "sku", "销量"),
    STATUS: ("日期", "数据类型", "平台", "店铺", "状态", "更新时间"),
    ORDER: ("销售日期", "平台", "店铺", "订单号", "SKU", "销量"),
}
CATEGORIES = {"完整": "complete", "确认零": "confirmedZero", "部分": "partial", "失败": "missing"}


def iso_date(value):
    if not isinstance(value, str) or not DATE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def whole_number(value):
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip()
    if re.fullmatch(r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?", text):
        text = text.replace(",", "")
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", text):
        return None
    number = Decimal(text)
    return int(number) if number == number.to_integral_value() else None


class Spreadsheet:
    def __init__(self, cli, locator):
        self.cli = cli
        self.token_args = self.locator_args(locator)
        metadata = self.metadata()
        self.revision = metadata["revision"]
        self.sheets = {}
        for sheet in metadata["sheets"]:
            title = sheet["sheet_name"]
            if sheet.get("resource_type") != "sheet" or sheet["is_hidden"]:
                continue
            if title in self.sheets:
                raise SourceError("DUPLICATE_SHEET_TITLE")
            self.sheets[title] = sheet

    @staticmethod
    def locator_args(locator):
        if "token" in locator:
            return ["--spreadsheet-token", locator["token"]]
        return ["--url", locator["url"]]

    def metadata(self):
        result = self.cli("sheets", "+workbook-info", *self.token_args)
        if not isinstance(result.get("revision"), int) or not isinstance(result.get("sheets"), list):
            raise SourceError("WORKBOOK_METADATA_INCOMPLETE")
        return result

    def verify_revision(self):
        if self.metadata()["revision"] != self.revision:
            raise SourceError("WORKBOOK_REVISION_CHANGED")

    def rows(self, title, region):
        if title not in self.sheets:
            raise SourceError("REQUIRED_SHEET_MISSING")
        result = self.cli("sheets", "+csv-get", *self.token_args, "--sheet-id",
                          self.sheets[title]["sheet_id"], "--range", region)
        if result.get("revision") != self.revision:
            raise SourceError("WORKBOOK_REVISION_CHANGED")
        if result.get("has_more") is not False or result.get("actual_range") != region:
            raise SourceError("SHEET_RANGE_INCOMPLETE")
        body = ROW_PREFIX.sub(lambda match: match.group(1) + ",", result.get("annotated_csv", ""))
        rows = {}
        for row in reader(StringIO(body)):
            if not row:
                continue
            try:
                number = int(row[0])
            except ValueError:
                raise SourceError("SHEET_ROW_REFERENCE_INVALID") from None
            if number in rows:
                raise SourceError("SHEET_ROW_REFERENCE_DUPLICATED")
            rows[number] = tuple(row[1:])
        return rows

    def full(self, title, last_column, rows_per_read=800):
        last_row = self.sheets.get(title, {}).get("row_count")
        if not isinstance(last_row, int) or not 1 <= last_row <= 200000:
            raise SourceError("SHEET_HEIGHT_INVALID")
        combined = {}
        for first in range(1, last_row + 1, rows_per_read):
            last = min(first + rows_per_read - 1, last_row)
            combined.update(self.rows(title, f"A{first}:{last_column}{last}"))
        return combined


def windows(numbers):
    start = previous = None
    for number in sorted(numbers):
        if start is None:
            start = previous = number
            continue
        if number - previous > 20 or number - start >= 550:
            yield start, previous
            start = number
        previous = number
    if start is not None:
        yield start, previous


def selected_rows(book, title, days, last_column):
    last_row = book.sheets.get(title, {}).get("row_count")
    if not isinstance(last_row, int) or not 2 <= last_row <= 200000:
        raise SourceError("REQUIRED_SHEET_HAS_NO_ROWS")
    dates = {}
    dates_per_read = 16000
    for first in range(1, last_row + 1, dates_per_read):
        last = min(first + dates_per_read - 1, last_row)
        dates.update(book.rows(title, f"A{first}:A{last}"))
    if dates.get(1) != (HEADERS[title][0],):
        raise SourceError("SOURCE_DATE_HEADER_CHANGED")
    invalid_dates = [row for row, values in dates.items() if row != 1 and values and values[0]
                     and not iso_date(values[0])]
    if invalid_dates:
        raise SourceError("SOURCE_DATE_UNRECOGNIZED")
    selected = {row: values[0] for row, values in dates.items()
                if row != 1 and values and values[0] in days}
    cells = {}
    for first, last in windows({1, *selected}):
        cells.update({number: row for number, row in book.rows(title, f"A{first}:{last_column}{last}").items()
                      if number == 1 or number in selected})
    if cells.pop(1, ()) != HEADERS[title]:
        raise SourceError("SOURCE_REQUIRED_COLUMNS_CHANGED")
    if cells.keys() != selected.keys() or any(not row or row[0] != selected[number] for number, row in cells.items()):
        raise SourceError("SOURCE_DATE_READBACK_MISMATCH")
    return cells


def sales_rows(book, days):
    for number, row in selected_rows(book, HISTORY, days, "E").items():
        day, platform, store, sku, units = (*row, "", "", "", "", "")[:5]
        yield (day, platform, store), sku, units, f"历史销售明细第 {number} 行"


def dated_rows(book, days):
    for day in sorted(days.intersection(book.sheets)):
        rows = book.full(day, "D")
        if rows.pop(1, ()) != ("平台", "店铺", "sku", "销量"):
            raise SourceError("DAILY_SALES_HEADER_CHANGED")
        for number, row in rows.items():
            if not any(row):
                continue
            platform, store, sku, units = (*row, "", "", "", "")[:4]
            yield (day, platform, store), sku, units, f"日表第 {number} 行"


def status_rows(book, days, scope):
    records = defaultdict(list)
    for number, row in selected_rows(book, STATUS, days, "F").items():
        day, category, platform, store, status, updated = (*row, "", "", "", "", "", "")[:6]
        key = day, platform, store
        if category != "销售" or (platform, store) not in scope:
            continue
        try:
            timestamp = datetime.fromisoformat(updated).isoformat()
        except ValueError:
            timestamp = None
        records[key].append((timestamp, number, status))
    statuses = {}
    for key, entries in records.items():
        maximum = max((item[0] or "" for item in entries), default="")
        newest = [entry for entry in entries if not entry[0] or entry[0] == maximum]
        flags = {entry[2] for entry in newest}
        statuses[key] = CATEGORIES.get(flags.pop(), "ambiguous") if len(flags) == 1 else "ambiguous"
    if not statuses:
        raise SourceError("SALES_COLLECTION_STATUS_ABSENT")
    return statuses


def ingest_sales(rows, scope, diagnostics):
    grouped = defaultdict(lambda: defaultdict(list))
    issues = defaultdict(list)
    seen_days = set()
    for key, sku, raw, evidence in rows:
        if key[1:] not in scope:
            diagnostics["salesOutsideStoreScope"] += 1
            continue
        seen_days.add(key[0])
        units = whole_number(raw)
        if not sku.strip():
            diagnostics["salesMissingSku"] += 1
            issues[key].append(("", "销量记录缺少 SKU", evidence))
        elif units is None or units < 0:
            diagnostics["salesInvalidQuantity"] += 1
            issues[key].append((sku, "源表销量为空或不可用", evidence))
        else:
            grouped[key][sku].append((units, evidence))
    return grouped, issues, seen_days


def consolidate(rows, issues, diagnostics):
    result = {}
    for sku, observed in rows.items():
        if len({item[0] for item in observed}) > 1:
            diagnostics["salesQuantityConflict"] += 1
            issues.append((sku, "同日同店 SKU 销量冲突", observed[0][1]))
        else:
            diagnostics["salesIdenticalRowsIgnored"] += len(observed) - 1
            result[sku] = observed[0]
    return result


def collect_rolling_sales(book, candidate_days, stores, order_scope):
    day_set = set(candidate_days)
    scope = set(stores)
    diagnostics = Counter()
    statuses = status_rows(book, day_set, scope)
    history, history_issues, historical_dates = ingest_sales(sales_rows(book, day_set), scope, diagnostics)
    daily, daily_issues, daily_dates = ingest_sales(dated_rows(book, day_set), scope, diagnostics)
    today = candidate_days[-1]
    today_available = today in historical_dates or today in daily_dates
    days = candidate_days[1:] if today_available else candidate_days[:-1]
    day_set = set(days)
    covered_dates = historical_dates | daily_dates | {key[0] for key, value in statuses.items()
                                                      if value == "confirmedZero"}
    if not day_set.issubset(covered_dates):
        raise SourceError("SALES_CALENDAR_COVERAGE_INCOMPLETE")
    if not any(day == candidate_days[-2] for day, _, _ in statuses):
        raise SourceError("SALES_NEWEST_COMPLETED_DAY_STATUS_ABSENT")
    coverage = defaultdict(Counter)
    sales = []
    review = []
    for platform, store in stores:
        for day in days:
            key = day, platform, store
            actual = statuses.get(key, "missing")
            issues = list(history_issues.get(key, []))
            historic = consolidate(history.get(key, {}), issues, diagnostics)
            dated_issues = list(daily_issues.get(key, []))
            fallback = consolidate(daily.get(key, {}), dated_issues, diagnostics)
            if historic and fallback and {sku: item[0] for sku, item in historic.items()} != {
                sku: item[0] for sku, item in fallback.items()
            }:
                diagnostics["overlappingSourcesDisagree"] += 1
                issues.extend((sku, "历史与日表销量不一致", evidence) for sku, (_, evidence) in historic.items())
            if fallback and (not historic or day == today):
                diagnostics["datedCurrentStoreDays" if day == today else "datedFallbackStoreDays"] += 1
                historic = fallback
                issues.extend(dated_issues)
            elif not historic or day == today:
                issues.extend(dated_issues)
            if (actual == "complete" and not historic) or (actual == "confirmedZero" and
                                                           any(item[0] > 0 for item in historic.values())):
                actual = "ambiguous"
            if issues:
                actual = "ambiguous"
            if day == today and actual in {"complete", "confirmedZero"}:
                actual = "partial"
            coverage[platform, store][actual] += 1
            for sku, reason, evidence in issues:
                if sku:
                    review.append({
                        "category": "销量缺值" if "空" in reason else "销量待核",
                        "source": f"{platform} / {store}", "date": day, "sku": sku,
                        "quantity": None, "unit": "件", "reason": reason, "evidence": evidence,
                    })
            for sku, (units, evidence) in historic.items():
                sales.append((day, platform, store, sku, units, actual == "complete", evidence))

    order_by_date = defaultdict(list)
    if order_scope in scope:
        for number, row in selected_rows(book, ORDER, day_set, "F").items():
            day, platform, store, order, sku, units = (*row, "", "", "", "", "", "")[:6]
            if (platform, store) == order_scope:
                order_by_date[day].append((order, sku, whole_number(units), number))
    return days, sales, coverage, review, order_by_date, diagnostics
