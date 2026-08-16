<div align="center">

[English](./README.md) · **简体中文**

</div>

# LobeHub 企业增强版

在 LobeHub 之上构建的企业管理后台、审计留痕与平台治理层。

> **非官方社区分支。** LobeHub 企业增强版**与 LobeHub LLC 无从属关系，未获其背书，也不由其提供支持**。
> 本项目是 [`lobehub/lobehub`](https://github.com/lobehub/lobehub) 的衍生作品，依据 **LobeHub Community License** 分发（见 [`LICENSE`](./LICENSE)）。
> "LobeHub" 是 LobeHub LLC 的商标，此处仅用于指代上游项目。

|          |                                              |
| -------- | -------------------------------------------- |
| 代码仓库 | `https://github.com/12dora/lobehub-enhanced` |
| 容器镜像 | `ghcr.io/12dora/lobehub-enhanced`            |
| 首个版本 | `v1.0.0`                                     |
| 上游基线 | `lobehub/lobehub` v2.2.10                    |

---

## 增强内容

以下功能全部是增量的：除非管理员主动开启某项治理能力，终端用户看到的仍是原本的聊天产品。所有企业能力都由环境变量开关控制，**默认关闭**。

| 领域       | 功能                           | 说明                                                                                                                                                                               |
| ---------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 管理后台   | 概览与统计                     | `/admin` 与 `/admin/stats`：总量、按用户统计、助理／模型／话题排行、52 周活跃度热力图、小时条带、Token 与费用视图；支持时间范围与用户筛选。                                        |
| 管理后台   | 用户管理                       | 列表与详情、角色分配、来源标签、按会话撤销登录态，以及带级联的硬删除（拒绝删除自己）。                                                                                             |
| 管理后台   | 受管资源                       | `/admin/unified`：由平台接管 AI／技能／连接器／助理，逐项控制启用、覆盖与可见性。                                                                                                  |
| 管理后台   | 设置策略                       | 取值顺序为 `内置默认 → 平台默认 → 用户覆盖 → 平台锁定`，`mode`（用户／默认／锁定）与可见性彼此独立。                                                                               |
| 管理后台   | AI 服务商与模型                | 平台自有的服务商与模型目录，支持连接测试、密钥 `保留\|替换\|清除`、硬删除。**接管闸门**保证只有在受管 AI 目录真正发布后，平台 AI 才会接管用户侧配置。                              |
| 管理后台   | 平台助理                       | 全局助理支持版本、下发范围、灰度发布（启动／重试／回滚／取消）、强制不可隐藏助理，以及默认收件箱设置。                                                                             |
| 管理后台   | 技能与连接器                   | 与上述一致的目录生命周期，内置工具权限矩阵，以及**平台托管的共享 OAuth 账号**（逐用户绑定、可批量解绑）。                                                                          |
| 管理后台   | 侧边栏布局                     | 由平台统一控制侧边栏顺序与显隐；托管期间用户端的布局菜单会隐藏。                                                                                                                   |
| 管理后台   | 任务模板                       | 管理端可增删改查首页推荐任务模板并逐条启用／停用，支持一键导入当前推荐库；一旦存在任何模板，平台列表即接管市场推荐。                                                               |
| 管理后台   | 品牌自定义                     | 名称、Logo、Favicon、OG 图、法律主体名、发件人、页面标题模板与**主题主色**；保存即全站生效，并在首屏同步注入，不会闪烁。                                                           |
| 安全与认证 | 登录方式                       | Authentik、通用 OIDC 与钉钉均在数据库中配置，向导支持实时发现、网络校验、安全登录测试、启用／停用与回滚，可同时启用多种登录方式；钉钉带企业白名单，企业 ID 通过扫码捕获而非手输。  |
| 安全与认证 | 生效控制                       | `PLATFORM_OIDC_RESTART_MODE=supervisor` 时可使用 "重启以生效" 按钮；磁盘上的 last-known-good 快照保证新配置加载失败时登录仍可用。本地应急管理员账号保留。                          |
| 安全与认证 | 注册策略                       | 开放注册开关与邮箱域名白名单联动，在注册链路内强制校验。                                                                                                                           |
| 审计       | 操作日志与实时查看             | 仅追加的管理操作日志，动作与对象名称均已翻译且可检索；另有进行中会话的实时查看。                                                                                                   |
| 审计       | 会话证据                       | 按用户、按话题浏览与检索会话证据，受独立权限保护（话题标题本身即视为证据）。                                                                                                       |
| 审计       | 导出、法务保全、留存           | 异步证据导出、法务保全与留存清理任务；存在生效中的保全时，留存删除会被阻断。                                                                                                       |
| 服务商     | ChatGPT 网页版（`chatgptweb`） | 网页会话形态的服务商：内置 `curl-impersonate` 二进制提供浏览器指纹传输，粘贴网页会话完成连接，会话 Cookie 自动续期，支持共享托管账号，状态面板会提示连接失效、需要管理员重新连接。 |
| 平台密钥   | 信封加密                       | 平台侧存储的每一份密钥都使用 AES-256-GCM 信封加密，密钥来自 `PLATFORM_MASTER_KEY` 或 HashiCorp Vault KEK，带版本化 KEK ID 与用于轮换的异步重加密任务。                             |
| 运行与运维 | 任务、实例、状态               | 基于租约、可跨 HTTP 工作进程存活的任务队列，带回收器的服务实例注册表，以及 `/admin/system/status` 实例与任务实时监控页。                                                           |

服务端授权只有一道闸门：每个管理接口都必须声明所需权限，注册表测试会断言接口总数，新增接口无法绕过鉴权上线。

## 界面截图

<table>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-overview.png" alt="概览"><br><sub><b>概览</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-task-templates.png" alt="任务模板"><br><sub><b>任务模板</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-login-methods.png" alt="登录方式"><br><sub><b>登录方式</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-audit-logs.png" alt="操作日志"><br><sub><b>操作日志</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-chatgpt-web.png" alt="ChatGPT 网页版共享账号"><br><sub><b>ChatGPT 网页版共享账号</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-branding.png" alt="品牌自定义"><br><sub><b>品牌自定义</b></sub></td>
</tr>
</table>

## 与上游的差异

| 变更                 | 说明                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| 关闭遥测             | 聊天遥测仅由 Langfuse 设置驱动；PostHog／Umami／Sentry 仅保留为未设置的构建参数。                        |
| 移除 EasyAuth        | EasyAuth IAM 集成已整体移除，改用数据库配置的身份提供方。                                                |
| 移除服务商草稿／发布 | AI 服务商的草稿 → 发布流程已拆除：在管理后台改动后立即生效。                                             |
| 迁移链压缩           | 全新数据库从 `0000_squash_baseline` 开始；已有的上游 2.2.10 数据库通过 `0001_upgrade_from_2_2_10` 升级。 |
| 精简发布流水线       | 桌面端与上游发布工作流已删除，唯一发布产物是多架构 Docker 镜像。                                         |
| 文档重写             | README 全部重写；分支文档位于 [`docs/enterprise/`](./docs/enterprise/)。                                 |
| 上游同步为手动       | 没有自动同步机制，上游变更经人工评审后逐条 cherry-pick。                                                 |

所有变更记录在 git 历史与本文件中，满足 Apache-2.0 §4 的变更声明义务。

## Docker 部署

### 环境要求

| 组件     | 要求                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 运行时   | Docker Engine + Docker Compose                                                                                                       |
| 数据库   | **`paradedb/paradedb:latest-pg17`** —— ParadeDB 自带 `pgvector` 与 BM25 检索；使用原版 `postgres` 镜像无法通过迁移。                 |
| 对象存储 | S3 兼容存储（随附 compose 使用 `rustfs`）。对外的 S3 地址必须**能被浏览器访问**，而不只是容器内可达 —— 预签名 URL 会直接交给客户端。 |
| 缓存     | Redis 可选，推荐启用。                                                                                                               |

### 快速开始

1. 克隆仓库，或只下载 [`docker-compose/enhanced/`](./docker-compose/enhanced/) 目录。

   ```bash
   git clone https://github.com/12dora/lobehub-enhanced.git
   cd lobehub-enhanced/docker-compose/enhanced
   ```

2. 创建环境变量文件。

   ```bash
   cp .env.example .env
   ```

3. 生成三个互相独立的密钥，写入 `.env`。

   ```bash
   openssl rand -base64 32 # AUTH_SECRET
   openssl rand -base64 32 # KEY_VAULTS_SECRET
   openssl rand -base64 32 # PLATFORM_MASTER_KEY
   ```

4. 设置 `APP_URL` 为对外访问地址，并设置 `BOOTSTRAP_SUPER_ADMIN_EMAIL`（若该账号尚不存在，需同时设置
   `BOOTSTRAP_ALLOW_CREATE=1`）。一次性管理员密码会在首次启动时**只打印一次**到应用日志：

   ```bash
   docker compose up -d
   docker compose logs app | grep -i bootstrap
   ```

5. 访问 `<APP_URL>/admin` 并用该账号登录，随后立即修改密码。

### 环境变量

必填：

| 变量                    | 含义                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `APP_URL`               | 对外访问地址，例如 `https://chat.example.com`。用于 OAuth 回调与预签名 URL。 |
| `DATABASE_URL`          | `postgresql://user:pass@host:5432/dbname`。容器启动时自动执行迁移。          |
| `AUTH_SECRET`           | 会话签名密钥，`openssl rand -base64 32`。                                    |
| `KEY_VAULTS_SECRET`     | 加密用户级 API Key，`openssl rand -base64 32`。                              |
| `PLATFORM_MASTER_KEY`   | 恰好 32 字节的 Base64 值，是全部平台密钥的 KEK。                             |
| `ENABLE_PLATFORM_ADMIN` | 置 `1` 后挂载 `/admin`、`admin.*` 接口以及用户菜单中的管理入口。             |

> **务必备份 `PLATFORM_MASTER_KEY`。** 丢失或在未执行重加密任务的情况下更换，会导致全部已存储的平台密钥
> —— 服务商密钥、连接器凭据、身份提供方 client secret —— 永久无法解密。

功能开关（全部默认关闭；可接受的真值为 `1`、`true`、`yes`、`on`）：

| 变量                                 | 含义                                               |
| ------------------------------------ | -------------------------------------------------- |
| `ENABLE_PLATFORM_MANAGED_AI`         | 由平台接管 AI 服务商与模型。                       |
| `ENABLE_PLATFORM_MANAGED_SKILLS`     | 平台受管技能目录取代用户自有技能。                 |
| `ENABLE_PLATFORM_MANAGED_CONNECTORS` | 平台受管连接器与共享 OAuth 账号。                  |
| `ENABLE_PLATFORM_MANAGED_AGENTS`     | 向用户下发平台助理。                               |
| `ENABLE_PLATFORM_SETTINGS_POLICY`    | 启用设置默认值／锁定策略解析。                     |
| `ENABLE_RUNTIME_BRANDING`            | 数据库品牌配置覆盖编译期的名称与 Logo。            |
| `ENABLE_DATABASE_OIDC`               | 启用数据库配置的登录方式（否则只走环境变量 SSO）。 |

`ENABLE_ENTERPRISE_ADMIN` 是 `ENABLE_PLATFORM_ADMIN` 的等价别名。

其他配置：

| 变量                                                                                                                                          | 含义                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_OIDC_RESTART_MODE`                                                                                                                  | 取 `supervisor` 时登录方式页面的 "重启以生效" 按钮可用；其他取值视为不支持重启。                               |
| `PLATFORM_OIDC_LKG_PATH`                                                                                                                      | 登录方式 last-known-good 快照的文件路径，需指向持久化卷。                                                      |
| `AUTH_COOKIE_PREFIX`                                                                                                                          | 为会话 Cookie 划分命名空间。若同一主机或域名下运行多个实例，**必须为每个实例设置不同的值**，否则会互相踢下线。 |
| `AUTH_SSO_PROVIDERS`                                                                                                                          | 使用数据库登录方式时**留空**，避免环境变量提供方遮蔽数据库配置。                                               |
| `S3_ENDPOINT`、`S3_PUBLIC_DOMAIN`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_REGION`、`S3_ENABLE_PATH_STYLE`、`S3_SET_ACL` | S3 兼容存储配置。`S3_PUBLIC_DOMAIN` 会写入预签名 URL，必须在浏览器侧可解析。                                   |
| `REDIS_URL`                                                                                                                                   | 可选的缓存／限流后端。                                                                                         |
| `PLATFORM_KEY_PROVIDER`、`VAULT_*`                                                                                                            | 设为 `PLATFORM_KEY_PROVIDER=vault` 时改由 HashiCorp Vault 提供 KEK，替代 `PLATFORM_MASTER_KEY`。               |
| `SSRF_ALLOW_PRIVATE_IP_ADDRESS`                                                                                                               | 置 `1` 允许访问内网／回环地址，单机部署常需开启。云元数据地址 `169.254.169.254` 始终被拦截。                   |

### 升级

```bash
docker compose pull && docker compose up -d
```

容器启动时自动执行数据库迁移，无需单独的迁移步骤。

### 镜像

`ghcr.io/12dora/lobehub-enhanced` —— 标签为 `latest`、`<major>.<minor>` 与 `<semver>`（例如 `1.0.0`，对应 git tag `v1.0.0`），构建
`linux/amd64` 与 `linux/arm64` 两种架构。Apple Silicon 机型通过 Docker Desktop 自动拉取 arm64 镜像。

参考 compose 文件见 [`docker-compose/enhanced/`](./docker-compose/enhanced/)；运维文档、接口参考与
运行手册见 [`docs/enterprise/`](./docs/enterprise/)。

## 登录方式

- **Authentik** —— 在 系统 → 安全与认证 → 登录方式 中配置，向导会实时请求 issuer 的 `.well-known/openid-configuration` 完成发现。详见 [`docs/enterprise/authentik-setup.md`](./docs/enterprise/authentik-setup.md)。
- **通用 OIDC** —— 任意符合 OpenID Connect 标准的提供方；在同一向导中配置发现地址、client id/secret、scope 与 claim 映射。
- **钉钉** —— 独立的登录方式类型（填写钉钉开放平台的 AppKey / AppSecret），以 `unionId` 作为稳定主体。仅允许企业白名单内的组织登录：管理员点击「通过钉钉登录添加企业」扫码后自动捕获企业 ID。详见 [`docs/enterprise/dingtalk-login.md`](./docs/enterprise/dingtalk-login.md)。

所有数据库配置的登录方式使用同一套回调地址格式，请在身份提供方侧原样登记：

```text
<APP_URL>/api/auth/oauth2/callback/<providerId>
```

## 本地开发

```bash
pnpm install  # 安装依赖
bun run dev   # Next.js + Vite SPA
bun run check # 一次跑完 lint 与相关测试
```

开发约定、项目结构与质量清单见 [`AGENTS.md`](./AGENTS.md)；本分支的架构与运维说明见
[`docs/enterprise/`](./docs/enterprise/)。

## 许可

本仓库依据 **LobeHub Community License** 分发，见原样保留的 [`LICENSE`](./LICENSE)。该许可为
Apache-2.0 **加附加条件**。

- **商业授权。** 依据 LobeHub Community License 第 1 (b) 条，基于上游项目开发并分发衍生作品，须先从
  LobeHub LLC 取得商业许可。LobeHub 企业增强版**属于**此类衍生作品，联系方式为 `hello@lobehub.com`。
  任何部署、修改或再分发本仓库的人，需自行负责合规。
- **变更声明。** 依据 Apache-2.0 §4，相对 `lobehub/lobehub` v2.2.10 的变更已在上文 "与上游的差异" 一节
  声明，并完整记录在 git 历史中。
- **版权。** 上游代码的版权仍归 LobeHub LLC 所有，全部上游版权、许可与署名声明均予保留。
- **商标。** 该许可不授予任何商标权利。"LobeHub" 是 LobeHub LLC 的商标，本仓库中仅用于说明本分支所
  衍生自的上游项目。
