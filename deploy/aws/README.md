# 易仓独立 AWS 部署

广州和深圳可以在团队 Git 仓库共同提交和评审代码。发布时各自选定经过验收的提交，在自己的 AWS 账号内构建或拉取对应镜像。每家公司独立管理站点域名、业务账号、生产环境变量、数据库卷和备份。测试环境使用独立数据卷与配置。

## 本机发布身份

由各公司的 AWS 管理员开通 IAM Identity Center 部署权限。Windows 使用 AWS CLI v2，首次创建本机配置，随后登录并确认部署角色对应的 AWS 账号。若同一维护人员有两家公司的授权，为两边各建一个具名配置。 [AWS CLI v2 安装说明](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

```powershell
aws configure sso --profile yicang-deploy
aws sso login --profile yicang-deploy
aws sts get-caller-identity --profile yicang-deploy
```

在同一 Windows 用户下换 Codex 账号时，可以打开原有本地代码目录，继续用 AWS CLI 的具名配置。SSO 到期后重新登录。各公司分别授权部署人员，运行易仓容器的 EC2 通过实例角色获取私有 ECR 镜像。把 AWS CLI 登录留在维护人员的本机，不需要把登录缓存交给服务器。 [AWS CLI 的 IAM Identity Center 配置](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html) · [EC2 实例角色](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html)

## 公司独立的 AWS 资源

当前部署工件适用于 AWS 商业分区。选择区域时，各公司分别确认访问、资源归属和数据保存位置。

1. 一台 Linux EC2 安装 Docker，由 Systems Manager 管理。给这台实例挂载同可用区的加密 EBS 数据卷，挂载到 `/srv/yicang-data`，设置随系统启动挂载，检查卷的 `DeleteOnTermination=false`。实际挂载后把数据目录授权给容器用户 UID/GID 1000。这套部署为一个可写应用进程和一个本地 SQLite 数据库。 [EBS 数据卷](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html) · [卷保留设置](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html) · [Systems Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
2. 由 Application Load Balancer 提供 HTTPS，证书覆盖易仓域名。负责转发应用的监听器规则先做 Cognito 认证，再转发到 EC2 的 3000 端口。EC2 的应用端口入站只允许 ALB 安全组，目标组用 `/api/ready` 检查实例。EC2 需要通过 HTTPS 访问当前 AWS Region 的 ALB 公钥端点。 [ALB 认证设置与 JWT 公钥](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
3. 为公司建立独立 Cognito 用户池与应用客户端，开启授权码流程。ALB 认证所用客户端启用客户端密钥，与 HTTPS 地址对应的回调 URL 为 `https://<易仓域名>/oauth2/idpresponse`。认证请求包含 `openid` 和 `email`，业务账号使用经过验证的邮箱。 [ALB 与 Cognito 的准备步骤](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#cognito-requirements)
4. 私有 ECR 存放本站镜像。构建机能访问依赖仓库和 ECR，EC2 实例角色能拉取所分配的镜像。镜像以 Git 提交号标记，发布和恢复时记录同一个标签或镜像摘要。 [ECR 镜像推送](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)

## 构建与发布

在已提交并通过检查的仓库根目录构建。以下命令以 x86_64 EC2 为例，把区域和仓库替换为该公司的值，镜像标记使用本次发布的提交号。

```powershell
$Region = '<AWS 区域>'
$Registry = '<AWS 账号 ID>.dkr.ecr.<AWS 区域>.amazonaws.com'
$Image = "$Registry/yicang:<提交号>"
aws ecr get-login-password --profile yicang-deploy --region $Region | docker login --username AWS --password-stdin $Registry
if ($LASTEXITCODE -ne 0) { throw 'ECR 登录失败' }
docker build --platform linux/amd64 --file deploy/aws/Dockerfile --tag $Image .
if ($LASTEXITCODE -ne 0) { throw '易仓镜像构建失败' }
docker push $Image
```

EC2 端使用实例角色登录 ECR 并拉取该镜像。 [ECR 登录说明](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html)

在 EC2 上准备权限为 `600` 的 `/etc/yicang/erp.env`。以下值是占位符，各环境替换为自己的 ALB、Cognito 和业务邮箱。

```dotenv
ERP_AWS_ALB_ARN=<该环境的 Application Load Balancer ARN>
ERP_AWS_OIDC_CLIENT_ID=<同一个 Cognito 客户端 ID>
ERP_AWS_OIDC_ISSUER=https://cognito-idp.<区域>.amazonaws.com/<用户池 ID>
ERP_PUBLIC_ORIGIN=https://<易仓域名>
ERP_WORKSPACE_NAME=广州易仓
ERP_ALLOWED_EMAILS=<首任管理员邮箱>,<已授权协作人邮箱>
ERP_DEV_OPEN_ACCESS=false
ERP_SQLITE_PATH=/data/erp.sqlite
```

首位邮箱用于初始化业务管理员，需要先由该账号登录一次。`ERP_PUBLIC_ORIGIN` 使用用户访问的 HTTPS 协议与域名，不附加路径。各公司用 `ERP_WORKSPACE_NAME` 标识自己的工作区。演示环境填测试人员邮箱并使用独立样例库。手工采购首期可只配置上述项目。以后接入 Shopify 或 MUKU 时，再由各公司维护自己的服务端密钥和入站回调规则。

在 `/etc/yicang/container.env` 写入 `IMAGE=<公司 ECR 仓库 URI>:<提交号>`，把本目录的 `yicang.service` 复制到 EC2，再安装为系统服务。服务只在 EBS 数据目录已挂载时启动。

```bash
sudo install -o root -g root -m 0644 yicang.service /etc/systemd/system/yicang.service
sudo systemctl daemon-reload
sudo systemctl enable --now yicang
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/ready
```

确认本机就绪和 ALB 目标健康后，通过 HTTPS 用已授权的账号检查 SKU、采购申请、复审、采购单和收货页面。再使用未授权账号验证业务接口拒绝访问。更新前备份数据库，拉取新版本后更新 `IMAGE` 并重启服务。保留上次镜像引用和对应备份。

## 备份与恢复

- 首次发布和每次升级前确认 EBS 已实际挂载。为加密数据卷保留独立快照，配置保留期限并演练恢复。应用容器启动时会读取持久化库和随镜像提供的迁移脚本。 [EBS 快照](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-snapshots.html)
- 需要备份运行中的 SQLite 时，使用 SQLite 在线备份接口。需要通过 EBS 快照获取一致版本时，安排短暂停机，停止易仓后制作快照。恢复时停止应用，从快照创建同可用区的数据卷，先在独立挂载点验证 SQLite 完整性和业务记录，再切换数据卷并启动。 [SQLite 备份接口](https://www.sqlite.org/backup.html) · [从快照创建 EBS 卷](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-volume.html)
- 旧镜像要求数据库结构兼容。应用版本与数据库结构一起变化时，恢复使用与所选镜像匹配的备份。保留原卷供核对。恢复后重新核对就绪接口、账号权限和单据数。
