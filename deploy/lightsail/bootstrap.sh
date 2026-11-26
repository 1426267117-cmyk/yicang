#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID != 0 || $# != 2 ]]; then
  printf 'Usage: sudo bash bootstrap.sh PUBLIC_IPV4 ACME_EMAIL\n' >&2
  exit 2
fi

public_ip=$1
acme_email=$2
if ! python3 -c 'import ipaddress, sys; sys.exit(not ipaddress.IPv4Address(sys.argv[1]).is_global)' "$public_ip"; then
  printf 'Provide the public IPv4 address attached to this Lightsail instance.\n' >&2
  exit 2
fi
if [[ ! $acme_email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  printf 'Provide an email address for the ACME account.\n' >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl nginx snapd xz-utils

install_node() {
  local architecture manifest="$scratch/SHASUMS256.txt" filename release checksum
  if [[ -x /opt/yicang-node/bin/node && $(/opt/yicang-node/bin/node --version) == v24.* ]]; then
    return
  fi
  case $(uname -m) in
    x86_64) architecture=x64 ;;
    aarch64) architecture=arm64 ;;
    *) printf 'Unsupported Linux architecture.\n' >&2; return 1 ;;
  esac

  curl -fsSL --proto '=https' --retry 3 -o "$manifest" https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
  filename=$(awk -v arch="$architecture" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$manifest")
  [[ $filename =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]]
  release=${filename#node-}
  release=${release%-linux-*}
  checksum=$(awk -v name="$filename" '$2 == name {print $1}' "$manifest")
  [[ $checksum =~ ^[a-f0-9]{64}$ ]]
  curl -fsSL --proto '=https' --retry 3 -o "$scratch/$filename" "https://nodejs.org/dist/$release/$filename"
  (cd -- "$scratch" && printf '%s  %s\n' "$checksum" "$filename" | sha256sum -c -)
  install -d -m 0755 /opt/yicang-node
  tar --no-same-owner -xJf "$scratch/$filename" -C /opt/yicang-node --strip-components=1
}

install_node
if ! id yicang >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/yicang --shell /usr/sbin/nologin yicang
fi
install -d -m 0755 /opt/yicang/releases /var/www/yicang-acme
install -d -m 0700 /etc/yicang
install -d -o yicang -g yicang -m 0700 /var/lib/yicang
install -m 0644 "$script_dir/yicang.service" /etc/systemd/system/yicang.service
systemctl daemon-reload

if [[ ! -e /etc/yicang/erp.env ]]; then
  umask 077
  secret=$(/opt/yicang-node/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')
  cat > /etc/yicang/erp.env <<EOF
ERP_AWS_AUTH_MODE=cognito
ERP_AWS_OIDC_ISSUER=
ERP_AWS_OIDC_CLIENT_ID=
ERP_AWS_COGNITO_DOMAIN=
ERP_AWS_SESSION_SECRET=$secret
ERP_PUBLIC_ORIGIN=https://$public_ip
ERP_ALLOWED_EMAILS=
EOF
  unset secret
  umask 022
fi

if ! snap list certbot >/dev/null 2>&1; then
  snap install certbot --classic
fi
certbot=/snap/bin/certbot
version=$("$certbot" --version | awk '{print $2}')
if [[ $(printf '%s\n' '5.4.0' "$version" | sort -V | head -n 1) != 5.4.0 ]]; then
  printf 'Certbot 5.4 or later is required for IP certificate webroot validation.\n' >&2
  exit 1
fi

site=/etc/nginx/sites-available/yicang
certificate=/etc/letsencrypt/live/yicang-ip
if [[ ! -s $certificate/fullchain.pem ]]; then
  cat > "$site" <<EOF
server {
    listen 80;
    server_name $public_ip;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/yicang-acme;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 404; }
}
EOF
  ln -sfn "$site" /etc/nginx/sites-enabled/yicang
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  "$certbot" certonly --webroot --webroot-path /var/www/yicang-acme \
    --preferred-profile shortlived --ip-address "$public_ip" --cert-name yicang-ip \
    --email "$acme_email" --agree-tos --non-interactive
fi
openssl x509 -in "$certificate/fullchain.pem" -noout -checkip "$public_ip"
openssl x509 -in "$certificate/fullchain.pem" -noout -checkend 0

cat > "$site" <<EOF
server {
    listen 80;
    server_name $public_ip;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/yicang-acme;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 308 https://$public_ip\$request_uri; }
}

server {
    listen 443 ssl;
    server_name $public_ip;
    ssl_certificate $certificate/fullchain.pem;
    ssl_certificate_key $certificate/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $public_ip;
    proxy_set_header X-Forwarded-Host $public_ip;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_buffering off;

    location = /api/ready { return 404; }
    location ^~ /api/purchase/feishu-preview/worker { return 404; }
    location = /api/purchase/skus/import {
        client_max_body_size 2056k;
        proxy_pass http://127.0.0.1:3000;
    }
    location = /api/auth/feishu/callback {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
    }
    location = /api/connectors/shopify/oauth/bizfurniz/callback {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
    }
    location = /api/connectors/shopify/oauth/zimasya/callback {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
    }
    location = /api/connectors/shopify/oauth/kaguyasu/callback {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
    }
    location = /api/connectors/shopify/oauth/anzhap/callback {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
EOF
ln -sfn "$site" /etc/nginx/sites-enabled/yicang
nginx -t
systemctl enable --now nginx
systemctl reload nginx

install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > "$scratch/reload-yicang-nginx" <<'EOF'
#!/bin/sh
set -eu
[ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/yicang-ip ] || exit 0
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
EOF
install -m 0755 "$scratch/reload-yicang-nginx" /etc/letsencrypt/renewal-hooks/deploy/30-yicang-nginx
systemctl enable --now snap.certbot.renew.timer
systemctl is-active --quiet snap.certbot.renew.timer
"$certbot" renew --cert-name yicang-ip --dry-run --run-deploy-hooks

printf 'HTTPS is ready. Configure Cognito values in /etc/yicang/erp.env before starting the ERP.\n'
