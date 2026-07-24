<!--
  AIHub Enterprise 二开 — Round-2 审计遗留清单(Outstanding Only)
  已修复/已删除的问题已从本文档移除;此处只保留仍有残留或已延后的项。
  完整修复已提交于分支 fix/enterprise-audit-round2 并上线 demo(aihub:demo=1fc67bf63e0b)。
-->

# 📋 AIHub 二开 Round-2 · 遗留问题清单(仅未闭合项)

> 本轮审计 135 条发现:**2 CRITICAL + 19 HIGH + 51 MEDIUM + 36 LOW**。绝大多数已修复/删除并上线。
> 本文档**只列仍未完全闭合的项**(核心已修但有残留、或有意延后);已完全修复与已删除的条目不再记录。

## 汇总

| 类别 | 条数 | 说明 |
|---|---|---|
| 🟡 部分修复 | ~22 | 核心缺陷已修且已生效,残留=缺回归测试 / 极端规模边界 / 吞吐优化(**均不影响运行时正确性**) |
| ⏸️ 已延后 | ~9 | 有意识决定(风险 / 体量 / 深边界),需单独立项 |
| ❌ 未修复(破坏性) | **0** | 无 |

**结论:所有破坏性缺陷已闭合;下列为"锦上添花"或"高风险需单独处理"的残留。**

---

## 🔴 / 🟠 关键子系统遗留(原 CRITICAL/HIGH,核心已修)

- 🟡 **audit/F1** [CRITICAL 核心已修]:销毁性作业"enqueue+必需审计"已事务化并上线。**残留**:缺"阻塞审计追加时并发 worker 不能 claim job"的双连接并发回归测试。
- 🟡 **ai/F1** [HIGH 核心已修]:服务端拒绝硬删已发布 provider + UI 隐藏删除动作已修。**残留**:缺 publish→archive/disable→拒删→运行时解析 证明不回退 BYOK 的回归测试。
- 🟡 **identity/F5** [HIGH→MED 核心已修]:audit reason 对替换/当前密钥脱敏、当前密钥不可读时 fail-closed 已修。**残留**:缺"不透明密钥不落入成功/失败审计"的回归测试。
- 🟡 **platform-instance/F2** [HIGH→MED 核心已修]:文件凭据 owner 绑定的原子轮换路径已实现。**残留**:缺 过期 stage / 回滚 / 并发轮换 的直接测试。
- ⏸️ **contracts/F4** [HIGH→MED]:secret-rotation 的 restart 合约已加,但 `cancelled`/`dead` 作业的 restart **实现路径(coordinator+admin service+router)未做**,这两类作业仍不可重启(旧密钥密文无法退休)。
- ⏸️ **contracts/F3 (sidebar CAS)** [MED]:sidebar 布局表无 revision 列,CAS 已**回退为直存(direct-save)**;两管理员并发改 sidebar 布局为 last-writer-wins(仅界面顺序,非安全)。完整 CAS 需加 revision 列+model/router/client。(安全相关的 auth-settings CAS 已完整落地,迁移 0147)
- ⏸️ **users-rbac/F1** [HIGH→MED]:GUC 信任的不可变/追加型触发器硬化(撤 app 角色 `DELETE` + `SECURITY DEFINER` 删除例程)**有意跳过**——会破正常删除路径,属 post-compromise 纵深防御,需单独审慎迁移+测试。

---

## 🟡 / ⏸️ MEDIUM / LOW 遗留(按分区)

### agents
- 🟡 **F4** [M]:客户端 mock 建错 CAS 曾掩盖刷新锁缺陷。核心已修(mock 分离 draftSequence/revision)。**残留**:mock 的 checksum 仍 `slice(0,64)` 截断,长 key 下草稿写入不改变 token;缺"草稿写入前后 token 断言 + 走真实 lock 链"回归。
- 🟡 **F5** [M]:effectiveResolver 固定 5× overscan 可能漏 agent。已改为循环扩展至凑满 1000 winner。**残留**:仍有 5 万行上限且每轮重复拉取增长前缀(非游标分页),超 5 万前导隐藏/重复行仍会漏;缺 >5k/>50k 回归。

### ai
- 🟡 **F3** [M]:批量模型变更曾近二次复杂度。已改一次加锁+一次草稿加载+依赖预取。**残留**:每项仍顺序单条 DML(最多约 500 条),bulk DML 未实现(纯吞吐优化)。
- ⏸️ **F4** [M]:PG 并发测试曾用墙钟 sleep。已改 `pg_locks` 观测。**残留**:锁查询范围过宽(接受任意库级未授予锁);清理对不可变/追加表用 `DELETE` 会 teardown 失败,待改按竞争后端 scope + `TRUNCATE`(仅 PG 套件 `TEST_SERVER_DB=1`)。

### audit
- 🟡 **F10** [M]:导出/下载全量缓冲有 OOM 风险。已加 256 MiB 工件字节上限封顶。**残留**:上传/上传后校验/下载校验仍全量缓冲,流式/分片 I/O 待做(性能项)。
- 🟡 **F12** [M]:边界回归测试不全。已补 users.timeline 与 rankTopics 授权回归。**残留**:禁用策略导出创建/执行/下载、真并发发布、清理重试、慢删双 worker 租约 四类回归仍缺。

### connectors
- 🟡 **F4** [M]:服务端 publish 曾不强制连接测试。已服务端强制"绑定 revision+draftToken 的非过期成功测试"(fail-closed)。**残留**:测试状态仍存进程内 map,多实例/serverless 下测试与发布跨进程会拒绝(而非误放行);未做事务级持久化/发布时实时探测;测试直接注入 map。

### identity
- 🟡 **F8** [M]:编辑向导第 2 页后曾用过期 revision。已用 mutation 返回值保留最新 revision。**残留**:仅缺 page-2 save→test/publish 模态级回归测试。
- 🟡 **F9** [M]:group-role 待处理映射曾无上限。已加 1 万上限 + 主动 sweep 过期/超额淘汰。**残留**:`discardIdentityProviderGroupRoleMapping` 无生产调用方(登录终态失败未接线);过期为访问触发式。
- ⏸️ **F10** [M]:墓碑停机测试漏掉"Disable 后立即整库停机"最危险窗口。旧 LKG 仍可复活被吊销 provider。**深边界延后**:需把吊销状态持久化到可失败 DB 读路径之外(触发条件=精确时刻整库停机)。

### platform-instance
- 🟡 **F4** [M]:系统健康轮询曾每 3s 哈希整目录。已加有界目录 token 加载器。**残留**:完全有界/增量聚合 token(避免随目录规模线性 rehash,尤其 skill 目录)待做(性能项)。
- ⏸️ **F8** [L]:迁移 0145 仅文本断言,未在库上重放。**残留**:缺 legacy fixture 应用 0145 两次验证数据转换/约束/索引/触发器的 replay 回归。

### routers
- 🟡 **F4** [M]:整月统计静默截断 + 串行 200 查询。**静默截断已修**(改 fail-closed 抛 `usage_month_truncated` + 回归)。**残留**:有意保留全量数组设计,串行查询/大数组内存的性能优化未做。

### scripts-tooling(CI 工具;production-trust 关闭时潜伏)
- 🟡 **F9** [M]:compose 校验曾整文件字符串匹配。已改按 `services.prometheus/otel-collector` 服务块严格解析 image/command。**残留**:`serviceHasMount` 仍用子串匹配,未强校验精确 target 且丢 `:ro`;缺负例。
- 🟡 **F10** [M]:pg_restore 管道未消费会死锁。已改 stdio `ignore`+背压+超时 SIGTERM→2s→SIGKILL。**残留**:超时在子进程 close 前 settle,子进程可能存活到 cleanup 之后;缺超时生命周期回归。
- 🟡 **F11** [M]:单测曾依赖 Docker/网络/180s 探针。已迁 `checkRules.integration.test.ts` opt-in(`ENTERPRISE_PROM_INTEGRATION=1`),单测恢复 hermetic。**残留**:原 invalid-PromQL 失败负例被删未迁回集成套件。
- ⏸️ **F14** [L]:多个工具文件 >800 行职责混杂。纯体量重构,延后(代码异味非缺陷)。

### security-guards
- 🟡 **F4** [M]:密钥轮换恢复曾要求 Vault 配置。get/list/cancel 已改无配置 coordinator。**残留**:`adminService.retry` 未传 `requireVault:false`,仍走 Vault 工厂(coordinator.retry 实为纯 DB 操作)→ Vault 宕机时无法 retry 失败任务(cancel/inspect 可用)。

### settings-branding
- 🟡 **F3** [M]:品牌发布冲突/刷新失败曾残留过期态。已加 markConflict 冲突态 + 提交后 committedRefresh 锁定态。**残留**:`refreshAuthoritative` 内 `mutate()` 拒绝未 try/catch(非破坏性边界);缺 publish-CAS 与提交后刷新失败回归。
- 🟡 **F5** [M]:桌面/主题品牌字段曾无控件。已补 Desktop(productName+图标上传)/Theme(primaryColor)段。**残留**:locale 缺 `branding.fields.theme` 键(段标题回退硬编码英文 'Theme');新控件无交互测试。
- 🟡 **F6** [M]:发布失败审计动作名不一致。branding 已统一 `admin.branding.publish` + 有界脱敏分类。**残留**:settings 侧可用性失败仍归 'internal'(无专用类别);审计测试未断言精确 `afterDiff.error`。
- ⏸️ **F10** [L]:品牌字面量策略仍是 915 行过度耦合模块。纯体量重构,延后。

### shared-infra
- 🟡 **F5** [M]:过期凭据引用曾被当 vault 仍存在。已按 `referencedCredKey` 校验 vault 成员。**残留**:loading 与 list 查询失败仍并入 `isConfigured`;缺删除凭据/过期引用/列表失败回归。

### skills
- 🟡 **F4** [M]:显式校验后曾不持久化结果致 UI 卡死。已在事务内 `updateVersionValidation` 持久化,UI 不再卡死。**残留**:审计追加未与持久化共用同一事务(先提交再单独 append);缺新旧时间戳 hook 回归。

---

_完整修复过程、验证与提交见分区提交历史(分支 `fix/enterprise-audit-round2`)与 `audit/round2/fix/` 编排产物。_
