#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID != 0 || -z ${SUDO_USER:-} || $SUDO_USER == root || $# -lt 2 || $# -gt 4 ]]; then
  printf 'Usage: sudo bash activate-feishu-release.sh ARCHIVE SHA256 [SNAPSHOT_JSON [--enable-worker]]\n' >&2
  exit 2
fi
archive=$(realpath -e -- "$1")
expected=${2,,}
snapshot=${3:-}
worker_flag=${4:-}
[[ -f $archive && $expected =~ ^[a-f0-9]{64}$ ]]
[[ -z $worker_flag || ( $worker_flag == --enable-worker && -n $snapshot ) ]]
if [[ -n $snapshot ]]; then
  snapshot=$(realpath -e -- "$snapshot")
  [[ -f $snapshot && $(stat -c %s "$snapshot") -le 786432 ]]
fi
actual=$(sha256sum < "$archive")
[[ ${actual%% *} == "$expected" ]]

app=/etc/systemd/system/yicang.service
worker=/etc/systemd/system/yicang-feishu-sync.service
worker_env=/etc/yicang/feishu-sync.env
source_config=/var/lib/yicang-feishu/sync-config.json
db=/var/lib/yicang/erp.sqlite
site=/etc/nginx/sites-available/yicang
enabled_site=/etc/nginx/sites-enabled/yicang
active=/opt/yicang/current
previous=$(readlink -f -- "$active")
[[ $previous =~ ^/opt/yicang/releases/[a-f0-9]{64}$ && -f $previous/server.js ]]
[[ -f $app && -f $db && ! -L $db && -f $site && ! -L $site ]]
[[ $(readlink -f -- "$enabled_site") == "$site" ]]
nginx -T 2>/dev/null | awk -v active="$enabled_site" '$0 == "# configuration file " active ":" { found=1 } END { exit !found }'
systemctl is-active --quiet yicang
exec 8>/run/lock/yicang-guarded-deploy.lock
flock -n 8

worker_was_active=false
if systemctl is-active --quiet yicang-feishu-sync; then worker_was_active=true; fi
enable_worker=false
if [[ $worker_flag == --enable-worker ]] \
  || { [[ $worker_was_active == true && -f $worker_env ]] && grep -qx 'ERP_FEISHU_MODE=continuous' "$worker_env"; }; then
  enable_worker=true
  [[ -f $worker_env && ! -L $worker_env && $(stat -c '%u:%a' "$worker_env") == 0:600 ]]
  grep -qx 'ERP_FEISHU_MODE=continuous' "$worker_env"
  grep -qx 'ERP_FEISHU_SYNC_AWS_ENABLED=true' "$worker_env"
  grep -Eq '^ERP_FEISHU_SYNC_WORKER_TOKEN=[a-zA-Z0-9_-]{32,128}$' "$worker_env"
  runuser -u yicang-feishu -- test -r "$source_config"
fi

umask 077
install -d -m 0700 /var/backups/yicang
backup=$(mktemp -d /var/backups/yicang/release-XXXXXXXX)
cp -p -- "$app" "$backup/original.service"
cp -p -- "$site" "$backup/original.nginx"
tar -xOzf "$archive" deploy/lightsail/install-release.sh > "$backup/install-release.sh"
tar -xOzf "$archive" deploy/lightsail/yicang.service > "$backup/new.service"
tar -xOzf "$archive" deploy/lightsail/yicang-feishu-sync.service > "$backup/new-worker.service"
test -s "$backup/install-release.sh"
test -s "$backup/new.service"
test -s "$backup/new-worker.service"

public_host=$(python3 - "$backup" <<'PY'
from ipaddress import IPv4Address
from pathlib import Path
import re
import sys

backup = Path(sys.argv[1])
source = (backup / "original.nginx").read_text()
anchor = re.compile(r"(?m)^(?P<indent>[ \t]*)location[ \t]+=[ \t]+/api/ready[ \t]*\{[ \t]*return[ \t]+404;[ \t]*\}[ \t]*$")
worker = "location ^~ /api/purchase/feishu-preview/worker { return 404; }"
hosts = set(re.findall(r"(?m)^[ \t]*server_name[ \t]+([^;\s]+);[ \t]*$", source))
if len(hosts) != 1 or len(list(anchor.finditer(source))) != 1 or "return 503;" in source:
    sys.exit("The active nginx site does not match the Guangzhou Lightsail layout")
host = str(IPv4Address(hosts.pop()))
if "listen 443 ssl;" not in source or "proxy_pass http://127.0.0.1:3000;" not in source:
    sys.exit("The active nginx site has an unexpected TLS or backend binding")
if source.count("/api/purchase/feishu-preview/worker") != source.count(worker) or source.count(worker) > 1:
    sys.exit("The active nginx site has a custom Feishu worker route")
normal = source if worker in source else anchor.sub(lambda m: m[0] + "\n" + m["indent"] + worker, source)
root_proxy = re.compile(r"(?ms)^(?P<indent>[ \t]*)location[ \t]+/[ \t]+\{[ \t]*\n(?P<body>.*?)^(?P=indent)\}")
proxy_pass = "proxy_pass http://127.0.0.1:3000;"
for path, directive in (
    ("/api/purchase/skus/import", "client_max_body_size 2056k;"),
    ("/api/auth/feishu/callback", "access_log off;"),
    *((f"/api/connectors/shopify/oauth/{store}/callback", "access_log off;")
      for store in ("bizfurniz", "zimasya", "kaguyasu", "anzhap")),
):
    exact = re.compile(rf"(?ms)^([ \t]*)location[ \t]+=[ \t]+{re.escape(path)}[ \t]+\{{[ \t]*\n(.*?)^\1\}}")
    locations = list(exact.finditer(normal))
    if locations:
        if len(locations) != 1 or directive not in locations[0][2] or proxy_pass not in locations[0][2]:
            sys.exit(f"The active nginx site has a custom proxy for {path}")
        continue
    location = root_proxy.search(normal)
    if not location or proxy_pass not in location["body"]:
        sys.exit(f"The active nginx proxy cannot be reused for {path}")
    indent = location["indent"]
    block = f"{indent}location = {path} {{\n{indent}    {directive}\n{location['body']}{indent}}}\n\n"
    normal = normal[:location.start()] + block + normal[location.start():]
maintenance = anchor.sub(lambda m: m["indent"] + "return 503;\n" + m[0], normal)
(backup / "new.nginx").write_text(normal)
(backup / "maintenance.nginx").write_text(maintenance)
print(host)
PY
)

bash "$backup/install-release.sh" "$archive" "$expected" --stage-only
[[ $(readlink -f -- "$active") == "$previous" ]]

changed=false
db_may_have_changed=false
committed=false
seed_dir=

replace_site() {
  install -m 0644 "$1" "$site.pending" && mv -Tf -- "$site.pending" "$site"
}

restore_previous() {
  systemctl stop yicang || return 1
  if [[ $db_may_have_changed == true ]]; then
    # No production traffic has been admitted since maintenance began.
    for suffix in -wal -shm ''; do
      if [[ -e $db$suffix ]]; then mv -- "$db$suffix" "$backup/rejected.sqlite$suffix" || return 1; fi
    done
    install -o yicang -g yicang -m 0600 "$backup/erp.sqlite" "$db.restore" || return 1
    mv -Tf -- "$db.restore" "$db" || return 1
  fi
  install -m 0644 "$backup/original.service" "$app" || return 1
  ln -s -- "$previous" "/opt/yicang/.rollback.$$" || return 1
  mv -Tf -- "/opt/yicang/.rollback.$$" "$active" || return 1
  systemctl daemon-reload && systemctl start yicang || return 1
  curl -fsS --retry 10 --retry-connrefused --retry-delay 2 http://127.0.0.1:3000/api/ready >/dev/null || return 1
  replace_site "$backup/original.nginx" && nginx -t && systemctl reload nginx || return 1
  if [[ $worker_was_active == true ]]; then systemctl start yicang-feishu-sync || return 1; fi
}

finish() {
  result=$?
  trap - EXIT
  if [[ -n $seed_dir ]]; then
    rm -f -- "$seed_dir/snapshot.json"
    rmdir -- "$seed_dir" || true
  fi
  if ((result != 0)) && [[ $changed == true && $committed == false ]]; then
    if restore_previous; then
      printf 'The previous release was restored. Backup: %s\n' "$backup" >&2
    else
      printf 'Rollback could not be verified. Keep maintenance enabled and inspect %s.\n' "$backup" >&2
    fi
  elif ((result != 0)) && [[ $committed == true ]]; then
    printf 'The release passed readiness and was retained. Inspect the final proxy or worker check. Backup: %s\n' "$backup" >&2
  fi
  exit "$result"
}
trap finish EXIT

changed=true
replace_site "$backup/maintenance.nginx"
nginx -t
systemctl reload nginx
if [[ $worker_was_active == true ]]; then systemctl stop yicang-feishu-sync; fi
systemctl stop yicang

python3 - "$db" "$backup/erp.sqlite" <<'PY'
from contextlib import closing
from pathlib import Path
import sqlite3
import sys

source, target = map(Path, sys.argv[1:])
with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as original:
    with closing(sqlite3.connect(target)) as backup:
        original.backup(backup)
        if backup.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            sys.exit("SQLite backup quick_check failed")
PY
printf 'SQLite backup verified. Backup: %s\n' "$backup"

install -m 0644 "$backup/new.service" "$app"
systemctl daemon-reload
db_may_have_changed=true
bash "$backup/install-release.sh" "$archive" "$expected"
if [[ -n $snapshot ]]; then
  seed_dir=$(mktemp -d /var/lib/yicang/.seed-XXXXXXXX)
  chown yicang:yicang "$seed_dir"
  install -o yicang -g yicang -m 0600 "$snapshot" "$seed_dir/snapshot.json"
  runuser -u yicang -- /opt/yicang-node/bin/node "$active/scripts/import-feishu-procurement-preview.mjs" "$db" "$seed_dir/snapshot.json"
fi
curl -fsS http://127.0.0.1:3000/api/ready >/dev/null
replace_site "$backup/new.nginx"
nginx -t

# Once nginx can pass business requests, a database rollback could discard writes.
committed=true
systemctl reload nginx
worker_public_status=
for attempt in {1..10}; do
  worker_public_status=$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    --connect-to "$public_host:443:127.0.0.1:443" -X POST \
    "https://$public_host/api/purchase/feishu-preview/worker") || true
  [[ $worker_public_status == 404 ]] && break
  sleep 1
done
[[ $worker_public_status == 404 ]]
install -m 0644 "$backup/new-worker.service" "$worker"
systemctl daemon-reload
if [[ $enable_worker == true ]]; then
  systemctl enable --now yicang-feishu-sync
  systemctl is-active --quiet yicang-feishu-sync
  printf 'Feishu worker started. Verify its fresh successful sync in the authenticated ERP.\n'
else
  systemctl disable --now yicang-feishu-sync
  printf 'Feishu opening imports are available. The legacy scheduled worker is disabled.\n'
fi
printf 'Guangzhou release is ready. The worker endpoint is blocked on HTTPS.\n'
