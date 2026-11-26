# 易仓 Lightsail 试用部署

每家公司独立使用一台主机、一个 Cognito 用户池和一个本地 SQLite 业务库。可以从共同评审过的 Git 版本构建相同的源码包。这个方案使用 Lightsail 静态公网 IPv4 和 Let's Encrypt 的 IP 证书，试用地址形如 `https://<公网 IPv4>`。AWS 账户继续使用已有 Free Plan。

## 准备试用实例

在确认 AWS 控制台的试用额度和到期时间后，选择一台 2 GB 内存的 Ubuntu 24.04 Linux 公网 IPv4 实例，附加 Lightsail 静态 IPv4。给 HTTP-01 证书验证和续期开放 TCP 80，给网站开放 TCP 443。管理使用 Lightsail 浏览器 SSH，或将 SSH 限于维护端的来源地址。应用自身通过 systemd 固定监听 `127.0.0.1:3000`。 [Lightsail 规格](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html) · [端口规则](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html)

CloudShell 运行以下命令可核对当前区域可用的规格和系统镜像。使用实际返回的 ID 创建实例，然后为实例附加静态 IP。 [AWS CLI Lightsail 示例](https://docs.aws.amazon.com/cli/latest/userguide/cli_lightsail_code_examples.html)

```bash
region=us-east-1
aws lightsail get-bundles --region "$region" \
  --query 'bundles[?ramSizeInGb==`2`].[bundleId,name,price,supportedPlatforms]' --output table
aws lightsail get-blueprints --region "$region" \
  --query 'blueprints[?isActive==`true`].[blueprintId,name]' --output table
```

## 上传并核对源码

在 Windows 仓库根目录将经过审核的版本打成源码包。Linux 主机按锁文件重新安装依赖和运行 `npm run build:aws`。

```powershell
$Bundle = Join-Path ([System.IO.Path]::GetTempPath()) 'yicang-lightsail-source.tgz'
tar.exe -czf $Bundle --exclude '.env*' --exclude '*.pem' --exclude '*.key' --exclude '*.sqlite*' --exclude '*.db' app db drizzle lib public scripts types deploy/lightsail .openai/hosting.json package.json package-lock.json tsconfig.json next.config.ts vite.config.ts
if ($LASTEXITCODE -ne 0) { throw '源码包创建失败' }
Get-FileHash -Algorithm SHA256 -LiteralPath $Bundle
```

可以通过已授权的 SSH 连接上传。若使用 CloudShell，选择「上传文件」，把包暂存到已有的私有 S3 桶，生成短期 HTTPS 预签名下载链接，再在 Linux 主机拉取。预签名链接只用于这次受控传输。下载后核对 SHA-256，通过后再解包运行脚本。来源路径、下载链接、数据库和 AWS 凭证都由维护者独立管理。 [CloudShell 文件上传](https://docs.aws.amazon.com/cloudshell/latest/userguide/getting_started.html) · [S3 预签名下载](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html)

```bash
bundle="$HOME/yicang-lightsail-source.tgz"
expected='<Windows 原始文件 SHA-256>'
printf '%s  %s\n' "$expected" "$bundle" | sha256sum -c -
tar -xzf "$bundle" deploy/lightsail
```

## HTTPS 和登录

在专用 Ubuntu 主机上，用实际静态 IP 和证书联系人邮箱运行引导脚本。脚本会装 Node.js 24、Nginx 和 Certbot，申请浏览器信任的 IP 证书并验证续期。运行前阅读 Let's Encrypt 订阅协议。 [IP 证书发行和 Certbot 5.4 要求](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) · [Let's Encrypt 政策](https://letsencrypt.org/repository/)

```bash
sudo bash deploy/lightsail/bootstrap.sh '<静态公网 IPv4>' '<证书联系人邮箱>'
```

在 Cognito 建立独立的用户池、受管 AWS 前缀域名和无客户端密钥的公开应用客户端。开启授权码流程及 `openid email`，允许以下两个 HTTPS 地址为对应回调及退出地址。运维按实际使用人员创建和验证邮箱账号。 [Cognito 托管登录](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html)

- 回调地址 `https://<静态公网 IPv4>/api/auth/cognito/callback`
- 退出地址 `https://<静态公网 IPv4>/`

通过 sudo 编辑 `/etc/yicang/erp.env`。引导脚本已经生成随机会话密钥和 `ERP_PUBLIC_ORIGIN`，编辑时保留。填写以下四项，首个邮箱用于初始化易仓管理员。

```dotenv
ERP_AWS_OIDC_ISSUER=https://cognito-idp.<区域>.amazonaws.com/<用户池 ID>
ERP_AWS_OIDC_CLIENT_ID=<Cognito 客户端 ID>
ERP_AWS_COGNITO_DOMAIN=https://<前缀>.auth.<区域>.amazoncognito.com
ERP_ALLOWED_EMAILS=<管理员邮箱>,<获准测试人员邮箱>
```

## 飞书员工登录与岗位权限

员工入口使用公司飞书自建应用完成 OAuth 登录。把站点 HTTPS 地址加上 `/api/auth/feishu/callback` 填入该应用的重定向 URL，应用可用范围添加参与试用的员工。登录始终核对飞书企业租户和应用内稳定身份。HTTPS 代理应为该回调关闭访问日志，避免记录一次性授权码。 [飞书 OAuth](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/mobile-app)

易仓登录通过飞书 v2 接口以 JSON 换取令牌，用于兼容 v3 接口返回的 PKCE 校验错误。发起授权时仍发送 S256 挑战，兑换单次授权码时发送对应的校验值。飞书已将 v2 标为弃用，切回 v3 前需使用实际员工账号验证完整流程。 [飞书 v2 兑换文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token.md)

在服务器 `/etc/yicang/erp.env` 配置登录应用及独立会话密钥，保留负责人业务邮箱登录作为恢复入口。`ERP_FEISHU_LOGIN_SESSION_SECRET` 使用 32 字节随机值的无填充 Base64URL 编码（43 字符）。该应用和飞书数据同步任务分别配置。

```dotenv
ERP_FEISHU_LOGIN_ENABLED=true
ERP_FEISHU_LOGIN_REQUIRED=false
ERP_FEISHU_LOGIN_APP_ID=<公司飞书登录应用的 App ID>
ERP_FEISHU_LOGIN_APP_SECRET=<公司飞书登录应用的 App Secret>
ERP_FEISHU_LOGIN_TENANT_KEY=<公司飞书企业的 tenant_key>
ERP_FEISHU_LOGIN_SESSION_SECRET=<ERP 独立会话密钥>
```

员工首次登录后处于「待授权」。管理员进入「系统管理 → 团队权限」，在 ERP 工作区为每位员工分配采购、财务、渠道运营或仓库岗位。渠道岗位只读对应平台的订单与相关汇总，财务处理请款审批及实付台账，采购按指定负责人发起申请。已有邮箱账号的成员记录和历史指派保留，切换前需要把未完成事项交接给已授权的飞书成员。

用实际员工账号核对登录回调、首次待授权、分配权限后的页面及接口访问。核对工作已交接后，可把 `ERP_FEISHU_LOGIN_REQUIRED` 设为 `true`，员工统一从飞书登录，工作区负责人仍可使用原业务邮箱恢复访问。

## Shopify 订单接入

单店配置脚本从服务器私有环境读取该店的 `SHOPIFY_*_SHOP_DOMAIN`，缺少时交互填写官方 `myshopify.com` 域名。配置同店备用域名、授权回调和定时任务时参阅 [Shopify 订单近实时通知](../../docs/SHOPIFY_REALTIME_WEBHOOK.md)。

## 安装与检查

已经启用飞书同步的站点，可以使用带备份和回退的代码升级流程。两个参数的调用会直接使用站点数据库和服务器现有同步配置。

```bash
sudo bash deploy/lightsail/activate-feishu-release.sh "$bundle" "$expected"
```

新站初次安装时使用下方命令。

```bash
sudo bash deploy/lightsail/install-release.sh "$bundle" "$expected"
```

期望结果是回环就绪接口返回 HTTP 200。再从浏览器打开 HTTPS IP，核对实际呈现的证书和 Cognito 登录流程，用测试账号验证易仓表单。IP 证书有效期为 160 小时，80 端口继续只用于 HTTP-01 验证和 HTTPS 跳转。Certbot 定时扫描续期，续期成功后重新加载 Nginx。 [证书有效期](https://letsencrypt.org/docs/profiles/)

```bash
systemctl list-timers snap.certbot.renew.timer
sudo /snap/bin/certbot certificates
sudo journalctl -u yicang -n 30 --no-pager
```

新版发布前先备份 `/var/lib/yicang` 中的 SQLite 业务库。系统服务在各 Git 发布目录间切换，业务库位置固定。按证书续期状态和账户试用到期时间监控可用性。试用结束前将需要保留的测试数据导出。停止的 Lightsail 实例仍消耗额度，未附加的静态 IPv4 超过一小时也开始计费。若公网 IP 变化，需要换发证书并同步修改易仓 HTTPS 地址及 Cognito 回调地址。 [Lightsail 计费说明](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html)

如果公网 IP 证书在目标环境无法签发，可以单独验收 Lightsail CDN 的 AWS 托管 HTTPS 地址。切换前需确认源站保护、登录回调、会话 Cookie、请求头转发及动态接口缓存规则，再发布 HTTPS 链接。 [Lightsail 托管 HTTPS](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-web-addresses.html)

## 在线备份与离线核验

在对应公司的服务器使用实际写入数据库的工作区名。两家公司使用各自的 SQLite 文件、私有备份目录和独立授权。备份包包含完整业务库，存放在公司授权的私有位置。

```bash
sudo install -d -m 0700 /var/backups/yicang/manual
sudo /opt/yicang-node/bin/node /opt/yicang/current/scripts/sqlite-backup.mjs create \
  --source /var/lib/yicang/erp.sqlite --output-dir /var/backups/yicang/manual \
  --workspace '<库内工作区名>'
```

应用运行时可以执行。命令输出 `bundle` 目录名，目录包含 `erp.sqlite` 和 `manifest.json`。将完整目录保存到同公司的授权存储。出现中断后，仅以命令验证通过的完整目录为准。 [SQLite 在线一致性快照](https://www.sqlite.org/lang_vacuum.html)

在有相同或更新迁移文件的维护环境中，对备份包再做一次离线核验。核验只读检查文件大小、SHA-256、数据库完整性、外键、工作区和迁移记录。

```bash
sudo /opt/yicang-node/bin/node /opt/yicang/current/scripts/sqlite-backup.mjs verify \
  --bundle '/var/backups/yicang/manual/<输出的 bundle 目录名>' \
  --workspace '<库内工作区名>'
```
