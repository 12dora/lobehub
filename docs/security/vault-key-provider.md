# Vault Key Provider 安全配置与轮换

`VaultKeyProvider` 为 Platform Secret Service 提供 HashiCorp Vault KV v2 KEK。生产环境必须使用 AppRole（推荐）或显式低权限 token；禁止使用 root token。选择 Vault 后，认证、权限、sealed、网络或数据格式错误都会 fail closed，且不会回退 `PLATFORM_MASTER_KEY`。

## KV v2 数据格式

默认 mount 为 `aihub`，默认 secret path 为 `platform/master-key`。写入 KV v2 的 `data` 必须严格符合：

```json
{
  "active": { "keyId": "vault:2026-07", "key": "<32-byte canonical base64>" },
  "historical": [{ "keyId": "vault:2026-06", "key": "<32-byte canonical base64>" }]
}
```

`keyId` 是写入密文 envelope 的稳定、不透明版本号。它只能使用字母、数字以及 `._:@+-`，最多 128 个字符。active 与 historical 的 keyId 必须唯一。

## 最小权限

应用 token 只需读取一个 KV v2 数据路径：

```hcl
path "aihub/data/platform/master-key" {
  capabilities = ["read"]
}
```

不要授予 `sys/*`、policy、auth 管理、list、create、update 或 delete 权限。生产 Vault 应启用 TLS 并校验证书。不要把 token、Role ID、Secret ID 或 KEK 写入仓库、命令历史、日志、监控标签和错误报告。

## 应用配置

AppRole（优先，以下静态环境变量模式只适用于 Vault 中配置为可重复使用、且由进程重启完成轮换的 SecretID）：

```dotenv
PLATFORM_KEY_PROVIDER=vault
VAULT_ADDR=https://vault.internal.example
VAULT_APPROLE_ROLE_ID=<deployment-secret>
VAULT_APPROLE_SECRET_ID=<deployment-secret>
VAULT_APPROLE_MOUNT_PATH=approle
VAULT_KV_MOUNT_PATH=aihub
VAULT_KV_SECRET_PATH=platform/master-key
```

低权限 token 可用 `VAULT_TOKEN` 替代两个 AppRole 变量。若同时给出完整 AppRole 与 token，AppRole 优先。Provider 会对登录所得 token 和显式 token 调用 `lookup-self`，任何包含 `root` policy 的 token 都会被拒绝。

生产环境推荐为 AppRole 设置有限 TTL / 使用次数，并通过 `secretIdProvider` 注入可刷新的 SecretID，而不是长期保存静态 `VAULT_APPROLE_SECRET_ID`：

```ts
const keyProvider = new VaultKeyProvider({
  address: '<from validated config>',
  auth: {
    method: 'approle',
    roleId: '<from secure config>',
    secretIdProvider: async (signal) => secretIdAgent.readFreshSecretId({ signal }),
  },
});
```

`secretIdAgent` 应是受控的 response-wrapping 解包器、Vault Agent、sidecar，或读取原子轮换且权限收紧文件的适配器。回调每次 AppRole 登录调用一次，并接收一个 `AbortSignal`；实现必须在 signal abort 后停止 I/O。回调与 Vault HTTP 请求共用有界 deadline（默认 5 秒），超时会脱敏、fail closed 并释放 single-flight，后续调用可以重试；迟到结果不会触发登录。token 续租失败或达到 max TTL 后，Provider 会通过回调取得新 SecretID 再登录。同一时刻的并发请求共享一次刷新。不要让业务进程持有生成 SecretID 或管理 AppRole 的权限。

## 轮换与回滚

1. 生成新的随机 32-byte KEK，并选择新的唯一 keyId。
2. 原 active 项原样移入 historical，将新 KEK 写为 active；保留所有仍被密文引用的历史项。
3. 用读取接口确认新写入的数据版本可用，再让应用重新读取。新密文会使用 active keyId，旧密文继续按 envelope keyId 解密。
4. 由持久化 Node worker 执行内部 `platform.secret.rewrap.v1` 作业，以不超过 50 条的事务批次重新封装旧密文。Vercel/serverless 实例不得启动该轮询器；部署必须为它提供独立的持久进程入口。
5. 查看父作业的稳定计数与失败分类；逐条失败只记录在内部 `platform.secret.rewrap.failure.v1` ledger。当前阶段没有管理员 API，调用方也不得绕过后续 S02c2 的同事务审计封装直接暴露这些内部原语。
6. 父作业成功仍只表示数据库 envelope 已完成扫描。固定结果门为 `externalArtifactGate=identity_lkg_instance_convergence_required`，且 `historicalKeyRemovalReady=false`；OIDC LKG 与实例收敛属于外部检查，worker 不会更新或确认它们。
7. 本作业绝不删除 KEK。只有后续受审计流程同时证明数据库无旧 keyId 引用、OIDC LKG / 实例均已收敛并且回滚窗口结束，才可另行批准移除 historical 项。

取消只会停止后续批次，不会回滚已经提交的 envelope；失败重试只处理该父作业 ledger 中仍为 `failed` 的精确行。作业执行期间 active keyId 必须始终等于冻结的 target keyId；Vault 不可用或 active 漂移时，当前批次（包括数据、ledger、游标与 checkpoint）整体回滚。

若轮换数据格式错误、Vault sealed 或权限丢失，停止发布并恢复上一 KV 版本；不要启用环境 KEK 回退。Vault token 续租失败时 AppRole 会先获取新 SecretID 再登录，显式 token 会直接 fail closed；过期 token 不会继续使用。

## 本地真实 Vault 验证

集成测试默认跳过。它会用 root token **仅引导**临时 KV mount、临时 AppRole 和低权限 policy；应用读取始终使用临时 AppRole，测试结束后清理资源：

```bash
AIHUB_TEST_VAULT_INTEGRATION=1 \
  AIHUB_TEST_VAULT_ADDR=http://127.0.0.1:8200 \
  AIHUB_TEST_VAULT_ROOT_TOKEN='<ephemeral-dev-root-token>' \
  bunx vitest run --silent='passed-only' \
  apps/server/src/enterprise/security/secret/keyProviders/vaultKeyProvider.integration.test.ts
```

只对一次性本地开发 Vault 使用该引导方式。不得把 root token 保存到 `.env`、测试快照、报告或 CI artifact。

总体安全边界与验收要求见 [企业威胁模型](./enterprise-threat-model.md)。
