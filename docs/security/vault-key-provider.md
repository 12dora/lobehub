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

不要授予 `sys/*`、policy、auth 管理、list、create、update 或 delete 权限。AppRole 的 Secret ID 应通过受控部署通道交付，设置有限 TTL / 使用次数；生产 Vault 应启用 TLS 并校验证书。不要把 token、Role ID、Secret ID 或 KEK 写入仓库、命令历史、日志、监控标签和错误报告。

## 应用配置

AppRole（优先）：

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

## 轮换与回滚

1. 生成新的随机 32-byte KEK，并选择新的唯一 keyId。
2. 原 active 项原样移入 historical，将新 KEK 写为 active；保留所有仍被密文引用的历史项。
3. 用读取接口确认新写入的数据版本可用，再让应用重新读取。新密文会使用 active keyId，旧密文继续按 envelope keyId 解密。
4. 分批调用 Platform Secret Service `rotate` 重新封装旧密文，并统计仍引用旧 keyId 的记录。
5. 只有确认无任何密文引用旧 keyId 且回滚窗口结束后，才移除对应 historical 项。

若轮换数据格式错误、Vault sealed 或权限丢失，停止发布并恢复上一 KV 版本；不要启用环境 KEK 回退。Vault token 续租失败时 AppRole 会重新登录，显式 token 会直接 fail closed；过期 token 不会继续使用。

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

总体安全边界与验收要求见 [M13 安全加固计划](../redevelopment/plan/M13_安全、Secret、SSRF、重新认证与审计加固.md)。
