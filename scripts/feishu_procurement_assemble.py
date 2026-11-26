"""Assemble the validated Guangzhou data into a read-only ERP preview."""

from collections import Counter, defaultdict
from hashlib import sha256
import re

from feishu_procurement_sales import SourceError


RULE_REF = re.compile(r"R-[0-9A-F]{12}|R-WFSZ\d{8}-\d{2}")
ORDER_DIGEST = re.compile(r"[0-9a-f]{64}")
WAREHOUSES = ("CA", "GA", "NJ")


def code(value):
    return str(value or "").strip().upper()


def order_sha256(normalized_order):
    return sha256(normalized_order.encode("utf-8")).hexdigest()


def totals(observations):
    verified = [row[0] for row in observations if row[1]]
    other = [row[0] for row in observations if not row[1] and row[0] != 0]
    return (sum(verified) if verified else None, sum(other) if other else None)


def issue(category, source, day, sku, quantity, reason, evidence, unit="件"):
    return {"category": category, "source": source, "date": day, "sku": sku, "quantity": quantity,
            "unit": unit, "reason": reason, "evidence": evidence}


def rule_refs(rules, fallback):
    return "、".join(rule["ruleId"] for rule in rules[:4]) or fallback


def rules_index(rules, rule_scope, order_sku_pattern, excluded_company):
    exact = defaultdict(list)
    order_rules = defaultdict(list)
    stock_rule = defaultdict(list)
    prefixes = []
    for rule in rules:
        if not isinstance(rule, dict) or not RULE_REF.fullmatch(str(rule.get("ruleId", ""))):
            raise SourceError("RULE_REFERENCE_INVALID")
        scoped = rule.get("platform"), rule.get("store")
        local_order = scoped == rule_scope
        store_sku, warehouse_sku = map(code, (rule.get("storeSku"), rule.get("warehouseSku")))
        aliases = {order_sku_pattern.sub("", key) for key in (store_sku, warehouse_sku)} if local_order else {store_sku}
        aliases.discard("")
        kind = rule.get("kind")
        if kind == "前缀":
            if not local_order or not store_sku or rule.get("company") != excluded_company:
                raise SourceError("PREFIX_RULE_SCOPE_INVALID")
            prefixes.append(rule)
        elif kind == "订单+SKU":
            if not local_order or not aliases or rule.get("company") != excluded_company:
                raise SourceError("ORDER_RULE_SCOPE_INVALID")
            order = code(rule.get("order"))
            digest = rule.get("orderSha256")
            if digest is None and order:
                digest = order_sha256(order)
            elif order or not isinstance(digest, str) or not ORDER_DIGEST.fullmatch(digest):
                raise SourceError("ORDER_RULE_IDENTIFIER_INVALID")
            for alias in aliases:
                order_rules[digest, alias].append(rule)
        elif kind == "SKU":
            for alias in aliases:
                exact[*scoped, alias].append(rule)
            for sku in ({store_sku, warehouse_sku} if local_order else {store_sku}) - {""}:
                stock_rule[sku].append(rule)
        else:
            raise SourceError("UNKNOWN_RULE_KIND")
    if not rules or not prefixes:
        raise SourceError("OWNERSHIP_RULES_INCOMPLETE")
    return exact, order_rules, prefixes, stock_rule


def assemble(day, days, sales, coverage, review, order_data, stock, transit, shared, rules, config):
    rule_scope = tuple(config["orderRuleStore"])
    order_pattern = re.compile(config["orderSkuPrefixPattern"])
    excluded_company = config["excludedCompany"]
    exact, order_rules, prefixes, stock_rule = rules_index(rules, rule_scope, order_pattern, excluded_company)
    order_skus = {key[1] for key in order_rules}
    order_by_day_sku = defaultdict(list)
    for sold_day, entries in order_data.items():
        for order, sku, qty, _ in entries:
            order_by_day_sku[sold_day, order_pattern.sub("", code(sku))].append((code(order), qty))
    sales_day_collisions = Counter((sold_day, order_pattern.sub("", code(sku)))
                                   for sold_day, platform, store, sku, *_ in sales if (platform, store) == rule_scope)
    retained_sales = defaultdict(list)
    for sold_day, platform, store, sku, units, verified, source_ref in sales:
        source = f"{platform} / {store}"
        local_order = (platform, store) == rule_scope
        full_sku = code(sku)
        match_sku = order_pattern.sub("", full_sku) if local_order else full_sku
        rule_matches = exact.get((platform, store, match_sku), [])
        external = [rule for rule in rule_matches if rule["company"] != excluded_company]
        excluded = [rule for rule in rule_matches if rule["company"] == excluded_company]
        prefix_match = [rule for rule in prefixes if local_order and match_sku.startswith(code(rule["storeSku"]))]
        if external or excluded or prefix_match:
            selected = external or excluded or prefix_match
            category = "非本公司" if external else "深圳剔除"
            reason = "清单标为非本公司" if external else ("店铺规则命中完整 SKU" if excluded else "命中深圳前缀规则")
            review.append(issue(category, source, sold_day, sku, units, reason, rule_refs(selected, source_ref)))
            continue

        remaining = units
        if local_order and match_sku in order_skus and units:
            key = sold_day, match_sku
            lines = order_by_day_sku.get(key, [])
            if sales_day_collisions[key] != 1 or not lines or len({line[0] for line in lines}) != len(lines) or any(
                    not order or qty is None or qty < 0 for order, qty in lines) or sum(qty for _, qty in lines) != units:
                review.append(issue("销量待核", source, sold_day, sku, units,
                                    "订单＋SKU规则候选。订单明细与日销量未一一对上", source_ref))
                continue
            for order, qty in lines:
                matched = order_rules.get((order_sha256(order), match_sku), [])
                if matched and qty:
                    review.append(issue("深圳剔除", source, sold_day, sku, qty,
                                        "订单与 SKU 同时命中。仅剔对应商品行", rule_refs(matched, source_ref)))
                    remaining -= qty
        if remaining == 0 and units != 0:
            continue
        if local_order and not full_sku.startswith(config["guangzhouSkuPrefix"]):
            review.append(issue("销量待核", source, sold_day, sku, remaining,
                                "未命中剔除规则。商品归属未确认", source_ref))
            continue
        retained_sales[full_sku, platform, store].append((remaining, verified))

    def stock_disposition(sku):
        matched = stock_rule.get(sku, [])
        if any(rule["company"] != excluded_company for rule in matched):
            return "归属待核", "与非本公司店铺规则使用同一编码", rule_refs(matched, "店铺 SKU 规则")
        if sku in shared:
            return "深圳共销", "与深圳共销库存同码。广州库存预览暂不纳入", f"深圳库存第 {shared[sku]} 行"
        if matched:
            return "归属待核", "与店铺深圳规则同码。仓库归属待确认", rule_refs(matched, "店铺 SKU 规则")
        return None

    retained_stock = {}
    for warehouse, sku, quantity in stock:
        disposition = stock_disposition(sku)
        if disposition:
            category, reason, evidence = disposition
            review.append(issue(category, f"美国站库存 / {warehouse}", None, sku, quantity, reason, evidence))
        else:
            retained_stock[warehouse, sku] = quantity
    retained_transit = []
    transit_totals = Counter()
    for row in transit:
        sku = code(row["sku"])
        disposition = stock_disposition(sku)
        if disposition:
            category, reason, evidence = disposition
            review.append(issue(category, f"在途库存 / {row['region']}", row["arrivalDate"], sku, row["pcs"],
                                reason, evidence, "PCS"))
        else:
            retained_transit.append(row)
            transit_totals[sku] += row["pcs"]

    store_sales = []
    summary_groups = defaultdict(list)
    for (sku, platform, store), observations in sorted(retained_sales.items()):
        verified, other = totals(observations)
        if not ((verified or 0) or (other or 0)):
            continue
        record = coverage[platform, store]
        days_trusted = record["complete"] + record["confirmedZero"]
        store_sales.append({
            "sku": sku, "platform": platform, "store": store,
            "verifiedSales": verified, "otherSales": other, "trustedDays": days_trusted,
            "averagePerDay": (verified or 0) / 30 if days_trusted == 30 else None,
        })
        summary_groups[sku].extend(observations)
    store_count = Counter(row["sku"] for row in store_sales)
    skus = []
    for sku, rows in summary_groups.items():
        verified, other = totals(rows)
        ca, ga, nj = (retained_stock.get((warehouse, sku)) for warehouse in WAREHOUSES)
        known = [quantity for quantity in (ca, ga, nj) if quantity is not None]
        stock_total = sum(known) if known else None
        if stock_disposition(sku):
            status = "库存归属待核"
        elif not known:
            status = "三仓均未匹配"
        elif len(known) < 3:
            status = "部分仓缺记录"
        elif stock_total == 0:
            status = "三仓确认可用为 0"
        else:
            status = "近期销量待核" if verified is None else "销量与库存已配对"
        skus.append({"sku": sku, "verifiedSales": verified, "otherSales": other, "storeCount": store_count[sku],
                     "ca": ca, "ga": ga, "nj": nj, "stockTotal": stock_total, "warehouseCount": len(known),
                     "transitPcs": transit_totals.get(sku), "status": status})
    if not skus:
        raise SourceError("SNAPSHOT_NO_ELIGIBLE_SKUS")
    return {
        "snapshotDate": day, "salesStart": days[0], "salesEnd": days[-1],
        "skus": sorted(skus, key=lambda row: (-(row["verifiedSales"] or 0), row["sku"])),
        "storeSales": sorted(store_sales, key=lambda row: (row["platform"], row["store"], row["sku"])),
        "transit": sorted(retained_transit, key=lambda row: (row["arrivalDate"], row["sku"], row["region"])),
        "review": sorted(review, key=lambda row: (row["category"], row["source"], row["sku"], row["date"] or "")),
    }
