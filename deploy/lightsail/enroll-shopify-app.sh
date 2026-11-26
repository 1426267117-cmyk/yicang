#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

if [[ $EUID != 0 || $# != 1 ]]; then
  printf 'Usage: sudo bash enroll-shopify-app.sh {zimasya|kaguyasu|anzhap|bizfurniz}\n' >&2
  exit 2
fi

case "$1" in
  zimasya) prefix=SHOPIFY_ZIMASYA ;;
  kaguyasu) prefix=SHOPIFY_KAGUYASU ;;
  anzhap) prefix=SHOPIFY_ANZ ;;
  bizfurniz) prefix=SHOPIFY_BIZFURNIZ ;;
  *) printf 'Unknown Shopify store.\n' >&2; exit 2 ;;
esac

exec 8>/run/lock/yicang-guarded-deploy.lock
flock -n 8 || { printf 'Another Yicang deployment is in progress.\n' >&2; exit 1; }
test -f /opt/yicang/current/server.js
systemctl is-active --quiet yicang
exec 3<>/dev/tty || { printf 'Use the interactive server terminal.\n' >&2; exit 1; }

IFS= read -r -p 'Shopify app Client ID: ' app_id <&3
[[ $app_id =~ ^[a-zA-Z0-9]{20,100}$ ]] || { printf 'Invalid Shopify Client ID.\n' >&2; exit 2; }
IFS= read -rs -p 'Shopify app Client Secret (hidden): ' app_secret <&3
printf '\n' >&3
[[ $app_secret =~ ^[a-zA-Z0-9_-]{20,150}$ ]] || { printf 'Invalid Shopify Client Secret.\n' >&2; exit 2; }

builtin printf '%s\n%s\n' "$app_id" "$app_secret" | python3 -c '
import base64, getpass, os, re, secrets, shutil, stat, subprocess, sys, tempfile, time, warnings
from pathlib import Path

prefix = sys.argv[1]
app_id, app_secret = sys.stdin.read().splitlines()
runtime_path = Path("/etc/yicang/erp.env")
jobs_path = Path("/etc/yicang/shopify-jobs.env")

def protected_read(path, *, optional=False):
    if optional and not path.exists() and not path.is_symlink():
        return None
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        sys.exit("The server environment file has unexpected protection.")
    return path.read_bytes()

def find(data, key):
    first = (key + "=").encode()
    matches = [line[len(first):].strip() for line in (data or b"").splitlines() if line.startswith(first)]
    if len(matches) > 1:
        sys.exit("A Shopify environment variable is defined more than once.")
    if not matches:
        return None
    value = matches[0].decode("ascii")
    if len(value) >= 2 and value[0] in {chr(34), chr(39)} and value[-1] == value[0]:
        return value[1:-1]
    return value

def set_value(data, key, value):
    first = (key + "=").encode()
    if find(data, key) == value:
        return data
    rows = [line for line in (data or b"").split(b"\n") if not line.startswith(first)]
    return b"\n".join(rows).rstrip(b"\n") + b"\n" + first + value.encode("ascii") + b"\n"

def normalize_shop_domain(value):
    domain = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com", domain):
        sys.exit("Use the canonical myshopify.com domain without a protocol or path.")
    return domain

def prompt_shop_domain():
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass("Canonical Shopify shop domain (hidden): ")
    except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
        sys.exit("Shopify shop domain entry was not completed.")

def write(path, data):
    fd, name = tempfile.mkstemp(prefix=".yicang-shopify-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)

def restart():
    subprocess.run(["systemctl", "restart", "yicang"], check=True, timeout=45)
    for _ in range(20):
        probe = subprocess.run(["curl", "-fsS", "--max-time", "2", "http://127.0.0.1:3000/api/ready"], capture_output=True, timeout=3)
        if probe.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("ERP readiness failed.")

before = protected_read(runtime_path)
jobs_before = protected_read(jobs_path, optional=True)
after = before
domain_key = prefix + "_SHOP_DOMAIN"
stored_domain = find(after, domain_key)
if stored_domain:
    normalize_shop_domain(stored_domain)
else:
    after = set_value(after, domain_key, normalize_shop_domain(prompt_shop_domain()))
for suffix, value in (("_CLIENT_ID", app_id), ("_CLIENT_SECRET", app_secret)):
    key = prefix + suffix
    existing = find(after, key)
    if existing is not None and existing != value:
        sys.exit("Different Shopify app credentials are already present for this store.")
    after = set_value(after, key, value)
for key in (prefix + "_CATALOG_READ_ENABLED", prefix + "_INITIAL_BACKFILL_ENABLED"):
    after = set_value(after, key, "true")
key = "ERP_CONNECTOR_CREDENTIALS_KEY"
existing_key = find(after, key)
if existing_key is not None:
    try:
        valid_key = len(base64.b64decode(existing_key, validate=True)) == 32
    except ValueError:
        valid_key = False
    if not valid_key:
        sys.exit("The existing credential encryption key is invalid.")
else:
    after = set_value(after, key, base64.b64encode(secrets.token_bytes(32)).decode("ascii"))

key = "ERP_INTERNAL_JOB_TOKEN"
app_token, job_token = find(after, key), find(jobs_before, key)
if app_token is not None and job_token is not None and app_token != job_token:
    sys.exit("Existing internal job tokens disagree.")
token = job_token or app_token or secrets.token_urlsafe(36)
if not re.fullmatch(r"[a-zA-Z0-9_-]{32,160}", token):
    sys.exit("The existing internal job token has an unexpected format.")
jobs_after = set_value(jobs_before, key, token)
if after == before and jobs_after == jobs_before:
    print("Shopify server settings are already present.")
    sys.exit(0)

backup = Path(tempfile.mkdtemp(prefix="shopify-app-", dir="/var/backups/yicang"))
shutil.copy2(runtime_path, backup / runtime_path.name)
if jobs_before is not None:
    shutil.copy2(jobs_path, backup / jobs_path.name)
try:
    write(runtime_path, after)
    write(jobs_path, jobs_after)
    restart()
except BaseException:
    write(runtime_path, before)
    if jobs_before is None:
        jobs_path.unlink(missing_ok=True)
    else:
        write(jobs_path, jobs_before)
    restart()
    sys.exit("Shopify settings could not be applied and were restored.")
print("Shopify server settings saved. Merchant authorization is still required.")
' "$prefix"
unset app_secret
