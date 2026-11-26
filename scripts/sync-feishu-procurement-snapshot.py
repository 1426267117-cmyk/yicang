"""Read Feishu through the configured CLI profile and refresh a local ERP preview JSON."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

from feishu_procurement_assemble import assemble
from feishu_procurement_sales import SourceError, Spreadsheet, collect_rolling_sales
from feishu_procurement_stock import collect_shared_inventory, collect_stock, collect_transit


class LarkCli:
    def __init__(self, profile, identity="user"):
        if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", profile):
            raise SourceError("LARK_PROFILE_INVALID")
        if identity not in ("user", "bot"):
            raise SourceError("LARK_IDENTITY_INVALID")
        self.command = self.resolve_command()
        self.profile = profile
        self.identity = identity

    @staticmethod
    def resolve_command():
        override = os.getenv("ERP_FEISHU_LARK_CLI")
        if override:
            executable = Path(override)
            if not executable.is_absolute() or not executable.is_file():
                raise SourceError("LARK_CLI_EXECUTABLE_INVALID")
            return [str(executable)]
        appdata = os.getenv("APPDATA")
        npm_entry = Path(appdata, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js") if appdata else None
        if npm_entry and npm_entry.is_file() and (node := shutil.which("node")):
            return [node, str(npm_entry)]
        if executable := shutil.which("lark-cli"):
            return [executable]
        raise SourceError("LARK_CLI_NOT_AVAILABLE")

    def __call__(self, product, action, *args):
        command = [*self.command, "--profile", self.profile, product, action, *args,
                   "--as", self.identity, "--format", "json"]
        environment = {**os.environ, "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1"}
        try:
            result = subprocess.run(command, env=environment, capture_output=True, check=False,
                                    encoding="utf-8", timeout=80,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            raise SourceError("LARK_CLI_READ_TIMEOUT") from None
        except (OSError, UnicodeError):
            raise SourceError("LARK_CLI_READ_FAILED") from None
        if result.returncode:
            codes = {"sheets": "LARK_SHEETS_READ_FAILED", "base": "LARK_BASE_READ_FAILED"}
            raise SourceError(codes.get(product, "LARK_CLI_READ_FAILED"))
        try:
            envelope = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise SourceError("LARK_CLI_OUTPUT_INVALID") from None
        if (not isinstance(envelope, dict) or envelope.get("ok") is not True
                or envelope.get("identity") != self.identity
                or not isinstance(envelope.get("data"), dict)):
            raise SourceError("LARK_CLI_READ_UNVERIFIED")
        return envelope["data"]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_rules(config, config_path):
    rule_file = config_path.parent / config["ownershipRulesFile"]
    payload = rule_file.read_bytes()
    if hashlib.sha256(payload).hexdigest() != config["ownershipRulesSha256"]:
        raise SourceError("OWNERSHIP_RULES_CHECKSUM_CHANGED")
    record = json.loads(payload.decode("utf-8-sig"))
    return record["rules"]


def publish_locally(output, snapshot):
    encoded = (json.dumps(snapshot, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".tmp", delete=False) as stream:
        stream.write(encoded)
        pending = Path(stream.name)
    try:
        pending.replace(output)
    finally:
        pending.unlink(missing_ok=True)
    return hashlib.sha256(encoded).hexdigest()


def run(config_path, output):
    config = read_json(config_path)
    if output.resolve() in {config_path.resolve(), (config_path.parent / config["ownershipRulesFile"]).resolve()}:
        raise SourceError("OUTPUT_OVERLAPS_SOURCE")
    stores = [tuple(item) for item in config["stores"]]
    if (len(stores) != 9 or any(len(item) != 2 or not all(item) for item in stores) or len(set(stores)) != 9
            or tuple(config["orderRuleStore"]) not in stores):
        raise SourceError("STORE_SCOPE_INVALID")
    rules = load_rules(config, config_path)
    cli = LarkCli(config["profile"], config.get("identity", "user"))
    today = datetime.now(timezone(timedelta(hours=8))).date()
    candidate_days = [(today - timedelta(days=offset)).isoformat() for offset in range(30, -1, -1)]

    def read_sales():
        book = Spreadsheet(cli, config["sales"])
        results = collect_rolling_sales(book, candidate_days, stores, tuple(config["orderRuleStore"]))
        book.verify_revision()
        return book.revision, results

    with ThreadPoolExecutor(max_workers=4) as executor:
        sales_future = executor.submit(read_sales)
        stock_future = executor.submit(collect_stock, cli, config["stock"])
        shared_future = executor.submit(collect_shared_inventory, cli, config["sharedStock"])
        transit_future = executor.submit(collect_transit, cli, config["transit"])
        sales_revision, (days, sales, coverage, review, order_data, diagnostics) = sales_future.result()
        stock, stock_revision = stock_future.result()
        shared, shared_revision = shared_future.result()
        transit, transit_revision, transit_source_count = transit_future.result()

    snapshot = assemble(today.isoformat(), days, sales, coverage, review, order_data, stock, transit, shared, rules, config)
    checksum = publish_locally(output, snapshot)
    return {
        "ok": True, "snapshotDate": snapshot["snapshotDate"], "salesStart": days[0], "salesEnd": days[-1],
        "todayProvisional": days[-1] == today.isoformat(), "sha256": checksum,
        "revisions": {"sales": sales_revision, "stock": stock_revision, "shared": shared_revision,
                      "transit": transit_revision},
        "counts": {"skus": len(snapshot["skus"]), "storeSales": len(snapshot["storeSales"]),
                   "transit": len(snapshot["transit"]), "review": len(review),
                   "warehouseSourceRows": len(stock), "transitSourceRows": transit_source_count,
                   "fullyCoveredStores": sum(value["complete"] + value["confirmedZero"] == 30
                                             for value in coverage.values())},
        "sourceDiagnostics": dict(diagnostics),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Private JSON source and rules configuration")
    parser.add_argument("--output", type=Path, required=True, help="Local candidate JSON destination")
    args = parser.parse_args()
    started = time.monotonic()
    try:
        result = run(args.config, args.output)
    except SourceError as exc:
        print(json.dumps({"ok": False, "code": str(exc), "elapsedSeconds": round(time.monotonic() - started, 1)}))
        return 1
    except (KeyError, TypeError, ValueError, OSError):
        print(json.dumps({"ok": False, "code": "SOURCE_CONFIG_OR_DATA_INVALID",
                          "elapsedSeconds": round(time.monotonic() - started, 1)}))
        return 1
    result["elapsedSeconds"] = round(time.monotonic() - started, 1)
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
