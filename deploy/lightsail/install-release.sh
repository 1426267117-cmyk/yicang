#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID != 0 || $# -lt 2 || $# -gt 3 || -z ${SUDO_USER:-} || $SUDO_USER == root ]]; then
  printf 'Usage: sudo bash install-release.sh ARCHIVE SHA256 [--stage-only]\n' >&2
  exit 2
fi
archive=$(realpath -- "$1")
expected=${2,,}
mode=${3:-}
if [[ ! -f $archive || ! $expected =~ ^[a-f0-9]{64}$ || ( -n $mode && $mode != --stage-only ) ]]; then
  printf 'Provide the trusted source archive and its SHA-256 checksum.\n' >&2
  exit 2
fi
actual=$(sha256sum < "$archive")
if [[ ${actual%% *} != "$expected" ]]; then
  printf 'Source archive checksum did not match.\n' >&2
  exit 1
fi

exec 9>/run/lock/yicang-release.lock
if ! flock -n 9; then
  printf 'Another Yicang release is already in progress.\n' >&2
  exit 1
fi

release="/opt/yicang/releases/$expected"
if [[ ! -f $release/server.js ]]; then
  stage=$(mktemp -d /var/tmp/yicang-build.XXXXXXXX)
  ready=$(mktemp -d /opt/yicang/releases/.install.XXXXXXXX)
  trap 'rm -rf -- "$stage" "$ready"' EXIT
  chown "$SUDO_USER" "$stage"
  install -o "$SUDO_USER" -m 0600 "$archive" "$stage/source.tgz"
  runuser -u "$SUDO_USER" -- bash -c '
    set -euo pipefail
    cd -- "$1"
    mkdir app-source
    tar --no-same-owner --no-same-permissions -xzf source.tgz -C app-source
    cd app-source
    export PATH=/opt/yicang-node/bin:$PATH
    npm ci --no-audit --no-fund
    npm run build:aws
  ' bash "$stage"
  cp -a "$stage/app-source/dist/standalone/." "$ready/"
  cp -a "$stage/app-source/drizzle" "$ready/"
  install -d "$ready/scripts" "$ready/lib" "$ready/deploy/lightsail"
  install -m 0644 "$stage/app-source/scripts/"{import-feishu-procurement-preview.mjs,run-feishu-procurement-sync.mjs,sync-feishu-procurement-snapshot.py,sync-feishu-nine-store-orders.py,feishu_procurement_assemble.py,feishu_procurement_sales.py,feishu_procurement_stock.py} "$ready/scripts/"
  install -m 0644 "$stage/app-source/lib/feishu-procurement-preview-contract.ts" "$ready/lib/"
  install -m 0644 "$stage/app-source/scripts/run-shopify-order-job.mjs" "$ready/scripts/"
  install -m 0644 "$stage/app-source/scripts/run-shopify-inventory-mirror-job.mjs" "$ready/scripts/"
  install -m 0644 "$stage/app-source/scripts/"{local-connector-order-job.mjs,run-amazon-order-job.mjs} "$ready/scripts/"
  install -m 0644 "$stage/app-source/scripts/sqlite-backup.mjs" "$ready/scripts/"
  install -m 0644 "$stage/app-source/deploy/lightsail/yicang-feishu-sync.service" "$ready/deploy/lightsail/"
  install -m 0644 "$stage/app-source/deploy/lightsail/"{yicang-shopify-order-job@.service,yicang-shopify-webhook.timer,yicang-shopify-reconcile.timer} "$ready/deploy/lightsail/"
  install -m 0644 "$stage/app-source/deploy/lightsail/"{yicang-shopify-inventory-mirror@.service,yicang-shopify-inventory-mirror@.timer} "$ready/deploy/lightsail/"
  install -m 0644 "$stage/app-source/deploy/lightsail/enroll-shopify-app.sh" "$ready/deploy/lightsail/"
  install -m 0644 "$stage/app-source/deploy/lightsail/"{yicang-amazon-orders.service,yicang-amazon-orders.timer} "$ready/deploy/lightsail/"
  if [[ ! -d $ready/node_modules/zod ]]; then
    cp -a "$stage/app-source/node_modules/zod" "$ready/node_modules/"
  fi
  test -f "$ready/server.js"
  chown -R root:root "$ready"
  chmod -R a+rX "$ready"
  chmod 0755 "$ready"
  mv -T -- "$ready" "$release"
fi

if [[ $mode == --stage-only ]]; then
  printf 'Release %s is staged.\n' "$expected"
  exit 0
fi

pending_link="/opt/yicang/.current.$$"
ln -s -- "$release" "$pending_link"
mv -Tf -- "$pending_link" /opt/yicang/current
systemctl enable yicang
systemctl restart yicang
curl --fail --retry 10 --retry-connrefused --retry-delay 2 http://127.0.0.1:3000/api/ready
printf '\nRelease %s is ready.\n' "$expected"
