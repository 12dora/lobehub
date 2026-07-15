# M13 · 安全、Secret、SSRF、重新认证与审计加固

> 波次：W1–W8  
> 估算：贯穿，集中 2–3 人周  
> 前置依赖：M00  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 建立平台管理功能的统一威胁模型和安全控制。
- 集中处理 Secret 加密、日志脱敏、外连安全、危险操作重新认证和审计。
- 避免每个业务模块各自实现不一致的安全方案。

## 2. 范围

- Platform Secret Service、Redaction、Safe Outbound HTTP、Reauth Guard、Audit Policy、速率限制、安全测试。
- 覆盖 Provider、Connector、OIDC、Branding 资产和用户管理。
- 建立安全事件和运维告警。

## 3. 明确非范围

- 不把数据库加密等同于完整 KMS 管理。
- 不允许前端承担 Secret 脱敏或权限判断。
- 不记录敏感请求体用于“方便排障”。

## 4. 当前源码落点

- `apps/server/src/modules/KeyVaultsEncrypt`：当前用户 Key Vault 加密。
- `packages/ssrf-safe-fetch` 与 SSRF 环境变量。
- Better Auth Session/重新认证能力。
- 已有 tRPC Context、日志和 S3 模块。

## 5. 建议新增目录/文件

- `apps/server/src/enterprise/security/platformSecretService.ts`。
- `safeOutboundHttpClient.ts`、`redaction.ts`、`reauthGuard.ts`、`auditPolicy.ts`。
- `docs/security/enterprise-threat-model.md`。

## 6. 目标设计

- Secret 使用 envelope encryption：数据密钥加密内容，主密钥由 KMS/Vault/受控环境提供；记录 key version 以便轮换。
- API 使用 replace semantics：`secretAction=keep|replace|clear`，永不回传掩码冒充原值。
- SSRF 校验在 DNS 解析前后和每次重定向执行；限制协议、端口、响应大小、超时。CIDR 默认策略按 G-07 决策：私网/本机放行、云 Metadata 阻断；策略可配置，公网暴露面（G-02 单机公网可达）主要依赖反代层与鉴权控制补偿。
- 危险动作要求近期认证，建议 5–15 分钟窗口；角色、OIDC、共享 Secret、最后管理员操作必须覆盖。
- Audit Diff 使用字段级 allowlist/denylist，Secret 仅记录 fingerprint/configured 状态。

## 7. 数据模型与持久化

- 可新增 Secret Metadata 表，密文本身优先放专用 Secret Store；若放数据库，字段与业务表分离。

## 8. 服务端 API / Contract

- 内部 Guard，不单独暴露通用解密 API。
- 管理 API 的 Secret 输入统一 Schema。
- `admin.security.getPosture` 只返回检查结果，不返回密钥细节。

## 9. 管理端与用户端 UI

- 管理页面显示 Secret 已配置、最后更新、轮换状态；不提供“查看原文”。
- 重新认证通过后恢复原操作，不把明文暂存在 localStorage。

## 10. 运行时接入

- 日志、Trace、Error Reporting、Audit 都调用统一 Redactor。
- 解密只在真正调用外部服务前发生，并尽可能缩短明文生命周期。

## 11. 分 PR 实施步骤

1. PR-S01：威胁模型、Secret 接口和 Redaction。
2. PR-S02：KMS/Vault Adapter 与轮换 PoC。
3. PR-S03：SafeOutboundHttpClient 和 SSRF 测试套件。
4. PR-S04：Reauth Guard、危险动作清单和安全事件。
5. PR-S05：渗透/依赖/日志泄露检查和整改。

## 12. 测试清单

- Secret 不出现在 API 响应、日志、Trace、审计、测试快照。
- SSRF 绕过用例、DNS 重绑定、重定向和大响应被阻止。
- CSRF、XSS、越权、IDOR、重放、速率限制用例。
- 主密钥轮换不导致已发布配置不可用。

## 13. 上线与回滚

- 安全组件在 M07/M09/M11 前进入生产基础环境。
- 若 KMS 不可用，默认 fail closed；是否允许 LKG 需按资源定义。

## 14. Definition of Done

- 高风险模块通过安全评审。
- 建立 Secret 轮换和事件响应 Runbook。
- 危险操作都有 Reauth、Reason、Audit。

## 15. 主要风险与控制

- 自建加密实现风险高；优先使用成熟 KMS/Vault。
- 过度日志会泄露信息，日志不足又难排障；采用结构化分类和 correlation ID。

## 16. 模块移交物

- 威胁模型、安全组件、测试套件、轮换/应急 Runbook、安全评审记录。
