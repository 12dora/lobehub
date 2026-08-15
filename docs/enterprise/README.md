# AIHub 企业版（二开）文档

AIHub 是基于 LobeHub 的企业内部版二次开发。本目录是这套二开能力的 **as-built** 参考文档：只描述当前代码的真实行为，不含实施排期、PR 拆分、进度记录等过程材料。

## 关键架构决策

1. **独立管理后台**：`/admin` 使用独立布局与独立路由树（`src/enterprise/client`），不嵌入普通用户设置页。
2. **平台域与用户域分离**：全局 Provider / Model / Skill / Connector / Agent 落在独立的 `platform_*` 表，不创建 "系统用户" 来承载全局资源。
3. **服务端 RBAC 是唯一授权依据**：前端隐藏菜单只用于体验优化，不构成安全控制；每个写操作在服务端经 `withPlatformPermission` 单闸鉴权。
4. **统一设置解析器**：用户设置按 `内置默认值 → 平台默认值 → 用户显式覆盖 → 平台锁定值` 解析；`mode`（user/default/locked）与 `visibility`（visible/hidden）正交。
5. **不可变版本 + 受控发布**：AI / Skill / Connector / Agent 采用 Draft / Published / Archived 与不可变 Revision，不直接编辑线上快照；变更类接口需 `reason` + `expectedRevision`（乐观并发）。
6. **外部登录 = Authentik-only**：企业唯一 IdP 为 Authentik（上游对接钉钉，透传钉钉用户名）。OIDC 配置存库、在线校验，发布后经管理后台 "重启激活" 按钮受控重启生效（非热更新）；保留本地 Break-glass 管理员。平台授权以内建 RBAC 为唯一执行点。
7. **Branding 只替换用户可见信息**：内部包名、协议 ID、数据库标识、许可证文本保持稳定。
8. **企业代码集中隔离**：企业代码集中在少数新增目录（见下方 "代码落点"）与少量稳定挂载点；上游直接修改点由 `scripts/enterprise/rebase-report.ts` 自动巡检，不再手工维护补丁台账。
9. **Secret 主密钥经 KMS/Vault**：平台 Secret 采用信封加密（KEK 版本化）；私网 / 本机地址默认放行、云 Metadata（169.254.169.254）恒阻断。

## 代码落点

| 层                                              | 目录                                         |
| ----------------------------------------------- | -------------------------------------------- |
| 管理后台 SPA（路由、导航、页面、Provider/Gate） | `src/enterprise/client`                      |
| 服务端 tRPC 路由与服务                          | `apps/server/src/enterprise`                 |
| 平台数据库 schema（`platform_*` 表）            | `packages/database/src/schemas/platform`     |
| 平台权限与角色常量                              | `packages/const/src/platform/permissions.ts` |
| 上游同步巡检                                    | `scripts/enterprise/rebase-report.ts`        |

## 文档地图

- **[reference/database-tables.md](./reference/database-tables.md)** — 平台数据库表清单与设计规约。
- **[reference/trpc-api.md](./reference/trpc-api.md)** — 企业 tRPC 路由 → procedure → 权限映射与接口统一规则。
- **[reference/admin-routes.md](./reference/admin-routes.md)** — `/admin` 路由与页面目录（以 `adminNavMeta.ts` 为准）与路由实现要求。
- **[reference/permission-matrix.md](./reference/permission-matrix.md)** — RBAC 角色 → 权限矩阵与不变式。
- **[authentik-setup.md](./authentik-setup.md)** — Authentik / 钉钉 OIDC 从零接入手册。
- **[chatgpt-web-provider.md](./chatgpt-web-provider.md)** — ChatGPT Web (`chatgptweb`) 服务商：curl-impersonate 传输层环境变量、开发机 / 镜像准备、共享账号接入、能力范围与已知限制。
- **[runbooks/](./runbooks/)** — 运维手册：回滚、灾难恢复、Prometheus 告警、上线预检、安全验收。
- **[../security/](../security/)** — 企业威胁模型与 Vault 密钥提供方设计。
