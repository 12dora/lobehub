# Q05・上游 Rebase 干跑门禁运行说明

本门禁交付 **隔离 dry-run 证据**，不是同步机器人，也不是生产 Rebase /push 授权。

## 范围

- Workflow：`.github/workflows/enterprise-upstream-rebase.yml`
- 分析器：`scripts/enterprise/rebase-report.ts`（只读、显式 SHA）
- 编排：`scripts/enterprise/upstream-rebase-ci/**`
- 权限：`contents: read` only；无 write token、无 `git push`、无 PR mutation、不把 main 直接 checkout/reset/merge

既有 `.github/workflows/sync.yml` 保持不变，职责分离：

| Workflow                         | 职责                                               |
| -------------------------------- | -------------------------------------------------- |
| `sync.yml`                       | Fork 侧上游同步（write，仅 fork）                  |
| `enterprise-upstream-rebase.yml` | 企业侧 dry-run 冲突 / 漂移 / 门禁证据（read-only） |

## CI 行为

1. `workflow_dispatch` 或每周一 03:17 UTC 的保守 schedule（fork 上 schedule 跳过）。
2. 校验 `upstream_repository`（`owner/name`）与 `upstream_ref`；拒绝任意 URL、凭据与 shell 元字符；仅构造 `https://github.com/<owner>/<name>.git`。
3. 在 **临时 clone** 中 bounded-depth fetch；merge-base 不足时 deepen /unshallow 升级。
4. 解析 base /upstream/candidate SHA，调用 rebase-report；冲突、patch drift、未验证 freshness、缺 gate、畸形 / 含密报告均失败。
5. 按报告 `requiredGates` 在 **集成树** 上确定性映射执行本地门禁：
   - `migration-upgrade-rollback` **仅**接受 reviewed Q03 `verify-migration` 合成 foundation 证据（owned PG upgrade/apply/rerun；overall 保持 unverified）。**禁止** journal / Migration-0 弱替代；Q03 缺失或 synthetic/rerun 不完整则失败闭合。**不**宣称 app-version rollback 或生产 dump overall-pass。
   - `failure-drills` 仅在具备 disposable PG/Redis（`TEST_SERVER_DB` + `DATABASE_TEST_URL` + `TEST_REDIS_URL`）时跑 reviewed 多 suite 真演练并经 `scripts/enterprise/failure-drills` collect/verify；否则明确 unavailable/failed。**禁止**仅用 runner/contract 单元测试冒充通过。
6. `continue-on-error` 步骤必须经最终 outcome 断言；缺报告、skip、0 assertion 不计通过。
7. 上传 **脱敏** evidence artifact；删除临时 clone 与 raw 输出；cleanup 失败即失败。

## 本地静态校验

```bash
bunx vitest run --config vitest.config.mts --silent='passed-only' \
  scripts/enterprise/upstream-rebase-ci/upstream-rebase-ci.test.ts \
  scripts/enterprise/rebase-report.test.ts

bun scripts/enterprise/upstream-rebase-ci/index.ts validate-inputs \
  --repository lobehub/lobehub \
  --ref main
```

本地完整 fetch + 报告需要网络与干净 worktree；仍 **不会** push 或改写 main。

## 证据边界

上传目录：`.records/enterprise-upstream-rebase/<run-id>-<attempt>/`

允许：短 SHA、计数、gate id/outcome、owner/name、ref、freshness 分类、schema 版本。

禁止：原始 remote URL、token、完整 commit message、diff / 文件正文、env、凭据。

## 仍需真实上游环境验证的事项

- 对真实 `lobehub/lobehub` 目标 ref 的周更 schedule 稳定性与 runner 耗时。
- merge-base 在极大分叉历史上的 unshallow 成本。
- 报告选中 `failure-drills` / 完整 `auth-e2e` 时，真实 PG/Redis/OIDC 仍以对应专用 workflow 为准；本门禁只跑可本地确定性映射的子集。
- 生产 merge/rebase 执行、PR 落地与发布签字不在本 dry-run 范围内。
