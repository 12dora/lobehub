<div align="center">

**简体中文** · [English](./README.en-US.md)

# LobeHub Enhanced・LobeHub 企业增强版

</div>

把开源的 LobeHub 变成一套**开箱即用的企业 AI 平台**：自带管理面板和用户管理，支持**钉钉扫码登录**与 **Authentik / 通用 OIDC 单点登录**，额外接入 **ChatGPT 网页版**等服务商并可全员共享一个账号，品牌名称与颜色随你定制，所有管理操作**全程留痕可审计**。一条 `docker compose up -d` 就能私有部署，Docker 镜像同时支持 x86-64 与 ARM（含 Apple 芯片）。

> 本项目是社区维护的非官方分支，**与 LobeHub LLC 无关，也未获其背书或支持**。它基于 [lobehub/lobehub](https://github.com/lobehub/lobehub) 二次开发，按 LobeHub Community License 分发（见 [LICENSE](./LICENSE)）。“LobeHub” 是 LobeHub LLC 的商标，此处仅用于说明上游项目。

|          |                                              |          |                                   |
| -------- | -------------------------------------------- | -------- | --------------------------------- |
| 代码仓库 | `https://github.com/12dora/lobehub-enhanced` | 容器镜像 | `ghcr.io/12dora/lobehub-enhanced` |
| 当前版本 | `v1.0.0`                                     | 上游基线 | `lobehub/lobehub` v2.2.10         |

## 新增功能

所有增强功能**默认开启**，需要时可用环境变量逐项关闭（见下文）。

| 新增功能                               | 支持 | 新增功能                               | 支持 |
| -------------------------------------- | :--: | -------------------------------------- | :--: |
| 管理面板（`/admin`）                   |  ✓   | 用户管理（角色、封禁、会话、删除）     |  ✓   |
| 钉钉扫码登录（企业白名单）             |  ✓   | Authentik / 通用 OIDC 单点登录         |  ✓   |
| 登录方式向导（测试、发布、回滚）       |  ✓   | 开放注册 + 邮箱域名白名单              |  ✓   |
| ChatGPT 网页版服务商                   |  ✓   | 共享平台账号（成员无需各自登录）       |  ✓   |
| AI 服务商与模型统一管理                |  ✓   | 平台助理（全员下发、灰度发布）         |  ✓   |
| 技能与连接器治理                       |  ✓   | 共享 OAuth 连接器授权                  |  ✓   |
| 设置策略（默认值 / 锁定）              |  ✓   | 侧边栏布局管控                         |  ✓   |
| 任务模板（首页推荐可增删改、拖拽排序） |  ✓   | 品牌自定义（名称、Logo、主色）         |  ✓   |
| 操作日志与实时查看                     |  ✓   | 会话历史、证据导出、法律保全、数据保留 |  ✓   |
| 数据统计与活跃度热力图                 |  ✓   | 状态监控（服务实例、后台任务）         |  ✓   |
| 平台密钥信封加密（主密钥 / Vault）     |  ✓   | 关闭遥测上报                           |  ✓   |
| 首个管理员容器内自动引导               |  ✓   | 多架构镜像（linux/amd64、linux/arm64） |  ✓   |

## 截图

<table>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-overview.png" alt="管理概览"><br><sub><b>管理概览</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-task-templates.png" alt="任务模板"><br><sub><b>任务模板</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-login-methods.png" alt="登录方式"><br><sub><b>登录方式（钉钉企业白名单）</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-audit-logs.png" alt="操作日志"><br><sub><b>操作日志</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-chatgpt-web.png" alt="ChatGPT 网页版"><br><sub><b>ChatGPT 网页版共享账号</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-branding.png" alt="品牌自定义"><br><sub><b>品牌自定义</b></sub></td>
</tr>
</table>

## 快速部署（Docker）

准备：一台装有 Docker 与 Docker Compose 的机器；数据库使用 `paradedb/paradedb:latest-pg17`（自带向量与全文检索，普通 postgres 镜像跑不通迁移）；对象存储用自带的 rustfs（其地址必须能被**浏览器**访问）；Redis 可选。

```bash
# 1. 获取部署文件（只需要 docker-compose/enhanced 目录）
git clone https://github.com/12dora/lobehub-enhanced.git
cd lobehub-enhanced/docker-compose/enhanced
cp .env.example .env

# 2. 生成三个独立密钥，填入 .env 的 AUTH_SECRET / KEY_VAULTS_SECRET / PLATFORM_MASTER_KEY
openssl rand -base64 32

# 3. 编辑 .env：APP_URL（对外访问地址）、S3_ENDPOINT / S3_PUBLIC_DOMAIN（浏览器可达的对象存储地址）、
#    BOOTSTRAP_SUPER_ADMIN_EMAIL（首个管理员邮箱）+ BOOTSTRAP_ALLOW_CREATE=1

# 4. 启动，并从日志里取一次性管理员密码
docker compose up -d
docker compose logs app | grep -i bootstrap

# 5. 打开 <APP_URL>/admin 登录，随后修改密码
```

| 必填变量                      | 说明                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `APP_URL`                     | 对外访问地址，如 `https://chat.example.com`                                                           |
| `DATABASE_URL`                | `postgresql://user:pass@host:5432/db`（启动时自动迁移）                                               |
| `AUTH_SECRET`                 | 登录会话签名密钥                                                                                      |
| `KEY_VAULTS_SECRET`           | 用户级 API Key 的加密密钥                                                                             |
| `PLATFORM_MASTER_KEY`         | 平台密钥的主密钥（base64，32 字节）。**务必备份**，丢失后已存的服务商 / 连接器 / 登录方式密钥无法解密 |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | 首个管理员邮箱；配合 `BOOTSTRAP_ALLOW_CREATE=1` 自动创建                                              |

增强功能默认全部开启；如需关闭某项，把对应变量设为 `0`：`ENABLE_PLATFORM_ADMIN`（管理面板）、`ENABLE_PLATFORM_MANAGED_AI`、`ENABLE_PLATFORM_MANAGED_SKILLS`、`ENABLE_PLATFORM_MANAGED_CONNECTORS`、`ENABLE_PLATFORM_MANAGED_AGENTS`、`ENABLE_PLATFORM_SETTINGS_POLICY`、`ENABLE_RUNTIME_BRANDING`、`ENABLE_DATABASE_OIDC`。使用数据库配置的登录方式时请保持 `AUTH_SSO_PROVIDERS` 为空。

升级：`docker compose pull && docker compose up -d`（迁移自动执行）。镜像标签：`latest`、`1.0`、`1.0.0`，支持 `linux/amd64` 与 `linux/arm64`（Apple 芯片的 Mac 通过 Docker Desktop 直接使用 arm64 镜像）。完整示例见 [`docker-compose/enhanced/`](./docker-compose/enhanced/)。

## AI 一键部署提示词

把下面这段话直接发给你的 AI 助手（Claude Code、Codex、Cursor 等），它会替你完成部署：

```text
请在这台机器上用 Docker 部署 LobeHub Enhanced：
1. git clone https://github.com/12dora/lobehub-enhanced.git，进入 docker-compose/enhanced，把 .env.example 复制为 .env。
2. 用 openssl rand -base64 32 生成三个不同的值，分别填入 AUTH_SECRET、KEY_VAULTS_SECRET、PLATFORM_MASTER_KEY。
3. 把 APP_URL 设为对外访问地址（本机试用填 http://localhost:3210）；把 S3_ENDPOINT 和 S3_PUBLIC_DOMAIN 设为浏览器能访问到的 http://<本机IP或域名>:9000；
   设置 BOOTSTRAP_SUPER_ADMIN_EMAIL=<我的邮箱> 和 BOOTSTRAP_ALLOW_CREATE=1。
4. 执行 docker compose up -d，等待 app 容器日志出现数据库迁移通过与 Ready，然后从日志中找到 bootstrap 打印的一次性管理员密码告诉我（只打印一次）。
5. 最后告诉我访问地址 <APP_URL>/admin，并把 .env 里需要备份的 PLATFORM_MASTER_KEY 提醒我保存好。
如遇端口冲突或镜像拉取失败，请说明原因并给出修复方案。
```

## 登录方式

在管理面板 **系统 → 安全与认证 → 登录方式** 中新建，向导会带你完成配置、测试与发布：

- **钉钉**：填写钉钉开放平台应用的 AppKey / AppSecret，然后点击「通过钉钉登录添加企业」扫码，企业 ID 会自动加入白名单 —— 只有白名单里的企业成员才能登录。回调地址：`<APP_URL>/oauth/identity-provider/dingtalk/<登录方式标识>`；应用需开通「通讯录个人信息读权限」，授权范围包含 `openid corpid`。详见 [`docs/enterprise/dingtalk-login.md`](./docs/enterprise/dingtalk-login.md)。
- **Authentik / 通用 OIDC**：填写发现地址与客户端凭据即可，回调地址：`<APP_URL>/api/auth/oauth2/callback/<登录方式标识>`。详见 [`docs/enterprise/authentik-setup.md`](./docs/enterprise/authentik-setup.md)。
- 测试登录用回调地址统一为 `<APP_URL>/oauth/identity-provider/test/callback`；多种登录方式可同时启用。

## 开发

```bash
pnpm install  # 安装依赖
bun run dev   # 启动开发环境
bun run check # 代码检查 + 相关测试
```

约定与结构见 [`AGENTS.md`](./AGENTS.md)，运维文档见 [`docs/enterprise/`](./docs/enterprise/)。

## 许可证

本仓库按 **LobeHub Community License**（Apache-2.0 附加条款）分发，`LICENSE` 原样保留。本项目是 lobehub/lobehub 的衍生作品：按该许可证第 1 (b) 条，**开发并分发衍生作品需要向 LobeHub LLC 取得商业授权**（<hello@lobehub.com>），使用者须自行确保合规。上游代码版权归 LobeHub LLC 所有，全部版权与许可声明均已保留；相对上游的改动记录在 git 历史与本文档中。
