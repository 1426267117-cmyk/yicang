#!/usr/bin/env bash
# Enroll the Guangzhou Feishu application from an interactive server terminal.
set +x
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }

if [[ $EUID != 0 || $# -lt 2 || $# -gt 3 ]]; then
  printf 'Usage: sudo bash enroll-feishu-worker.sh CONFIG_SHA256 RULES_SHA256 [APP_ID]\n' >&2
  exit 2
fi

state=/var/lib/yicang-feishu
account=yicang-feishu
config=$state/sync-config.json
rules=$state/feishu-ownership-rules.json
app=/opt/yicang/current
cli=/opt/yicang-feishu-cli/bin/lark-cli
service_path=/opt/yicang-node/bin:/usr/local/bin:/usr/bin:/bin
worker_env=/etc/yicang/feishu-sync.env
profile=guangzhou-procurement

exec 8>/run/lock/yicang-guarded-deploy.lock
flock -n 8 || fail 'Another Yicang deployment is in progress.'
[[ $(getent passwd "$account" | cut -d: -f6) == "$state" ]] || fail 'The Feishu service account home is invalid.'
case $(getent passwd "$account" | cut -d: -f7) in
  */nologin|/bin/false) ;;
  *) fail 'The Feishu service account must be non-login.' ;;
esac
[[ -d $state && ! -L $state && $(stat -c '%U:%G:%a' "$state") == "$account:$account:700" ]] \
  || fail 'The Feishu state directory owner or mode is invalid.'
[[ -x $cli && -f $app/scripts/sync-feishu-procurement-snapshot.py ]] || fail 'The Feishu CLI or collector is missing.'
[[ -f /etc/systemd/system/yicang-feishu-sync.service ]] || fail 'Install the Guangzhou release before enrolling Feishu.'

verify_file() {
  local path=$1 expected=${2,,} actual
  [[ $expected =~ ^[0-9a-f]{64}$ && -f $path && ! -L $path ]] || fail 'A source file or its SHA-256 is invalid.'
  [[ $(stat -c '%U:%G:%a' "$path") == "$account:$account:600" ]] || fail 'A Feishu source file owner or mode is invalid.'
  runuser -u "$account" -- test -r "$path" || fail 'The Feishu service cannot read its source files.'
  actual=$(sha256sum < "$path")
  [[ ${actual%% *} == "$expected" ]] || fail 'A Feishu source file did not match its SHA-256.'
}
verify_file "$config" "$1"
verify_file "$rules" "$2"
python3 - "$config" "$profile" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    config = json.load(f)
if (config.get("profile"), config.get("identity"), config.get("ownershipRulesFile")) != (sys.argv[2], "bot", "feishu-ownership-rules.json"):
    sys.exit("The Feishu source config does not select the Guangzhou bot profile and rule file.")
PY

if systemctl is-active --quiet yicang-feishu-sync; then
  fail 'The Feishu worker is already active. Stop it before enrolling a different application.'
fi
if [[ -e $worker_env || -L $worker_env ]]; then
  [[ -f $worker_env && ! -L $worker_env && $(stat -c '%u:%a' "$worker_env") == 0:600 ]] \
    || fail 'The Feishu worker environment owner or mode is invalid.'
  [[ $(grep -c '^ERP_FEISHU_SYNC_WORKER_TOKEN=' "$worker_env") == 1 ]] \
    && grep -Eq '^ERP_FEISHU_SYNC_WORKER_TOKEN=[a-zA-Z0-9_-]{32,128}$' "$worker_env" \
    || fail 'The existing worker token entry is invalid.'
fi

exec 3<>/dev/tty || fail 'Open an interactive server terminal to enter the Feishu credentials.'
app_id=${3:-}
if [[ -z $app_id ]]; then
  IFS= read -r -p 'Feishu App ID: ' app_id <&3
fi
[[ $app_id =~ ^cli_[a-zA-Z0-9]+$ ]] || fail 'The Feishu App ID is invalid.'
unset yicang_app_secret
IFS= read -rs -p 'Feishu App Secret (hidden): ' yicang_app_secret <&3
printf '\n' >&3
[[ -n $yicang_app_secret ]] || fail 'The Feishu App Secret is empty.'

worker_command=(runuser -u "$account" -- env
  -u LARKSUITE_CLI_CONFIG_DIR -u LARKSUITE_CLI_DATA_DIR -u LARKSUITE_CLI_APP_ID -u LARKSUITE_CLI_APP_SECRET
  -u LARKSUITE_CLI_USER_ACCESS_TOKEN -u LARKSUITE_CLI_TENANT_ACCESS_TOKEN
  "PATH=$service_path" "ERP_FEISHU_LARK_CLI=$cli")
cd "$state"
if ! builtin printf '%s\n' "$yicang_app_secret" | "${worker_command[@]}" "$cli" config init --app-id "$app_id" \
    --app-secret-stdin --brand feishu --name "$profile" >/dev/null 2>&1; then
  unset yicang_app_secret
  fail 'Feishu application enrollment failed.'
fi
unset yicang_app_secret

scratch=$(mktemp -d "$state/.enroll-XXXXXXXX")
chown "$account:$account" "$scratch"
env_stage=''
env_backup=''
activation_pending=false
cleanup() {
  local result=$?
  trap - EXIT
  if [[ $activation_pending == true ]]; then
    systemctl disable --now yicang-feishu-sync >/dev/null 2>&1 || true
    if [[ -n $env_backup ]]; then
      mv -fT -- "$env_backup" "$worker_env"
      env_backup=''
    else
      rm -f -- "$worker_env"
    fi
    systemctl restart yicang >/dev/null 2>&1 || true
  fi
  if [[ -n $env_stage ]]; then rm -f -- "$env_stage"; fi
  if [[ -n $env_backup ]]; then rm -f -- "$env_backup"; fi
  rm -f -- "$scratch/probe.json"
  rmdir -- "$scratch" || true
  exit "$result"
}
trap cleanup EXIT

printf 'Verifying a complete Feishu read as the Guangzhou bot (up to 4 minutes).\n'
cd "$app"
timeout -k 10s 240s "${worker_command[@]}" \
  python3 -B scripts/sync-feishu-procurement-snapshot.py --config "$config" --output "$scratch/probe.json" \
  || fail 'The Feishu bot did not complete the source read. The worker is disabled.'
[[ -s $scratch/probe.json ]] || fail 'The Feishu collector did not produce a verified candidate.'

env_stage=$(mktemp /etc/yicang/.feishu-sync-XXXXXXXX)
if [[ -f $worker_env ]]; then
  env_backup=$(mktemp /etc/yicang/.feishu-backup-XXXXXXXX)
  cp -- "$worker_env" "$env_backup"
  sed -E '/^ERP_FEISHU_MODE=|^ERP_FEISHU_SYNC_AWS_ENABLED=|^ERP_FEISHU_LARK_CLI=/d' "$worker_env" > "$env_stage"
else
  printf 'ERP_FEISHU_SYNC_WORKER_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$env_stage"
fi
printf '\nERP_FEISHU_MODE=continuous\nERP_FEISHU_SYNC_AWS_ENABLED=true\nERP_FEISHU_LARK_CLI=%s\n' "$cli" >> "$env_stage"
activation_pending=true
mv -fT -- "$env_stage" "$worker_env"
env_stage=''
systemctl daemon-reload
systemctl enable yicang >/dev/null
systemctl restart yicang
ready=false
for attempt in {1..20}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/ready >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ $ready == true ]] || fail 'ERP readiness failed. Restoring the previous worker environment.'
systemctl enable --now yicang-feishu-sync
systemctl is-active --quiet yicang-feishu-sync || fail 'The Feishu worker failed to start.'
activation_pending=false
printf 'Feishu bot source read passed and the Guangzhou worker started. Check its first successful import in ERP.\n'
