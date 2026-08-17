# G0d — per-module idle RSS（C+D 构建，无 rebuild）

基线（full，2 boot 中位）：rest **279.6 MB** / heap 113.0；burst **327.9** / 175.8。  
`delta = baseline − disabled`，整 MB；**|Δ|≤3 或负值记 0**。基线 burst 两样本已差 14 MB，hot 模块 4–12 的 burst-only 抖动视为噪声。deviceGateway rest r1=217 是离群点（并发 docker build），按 0。

| module | RSS rest | RSS burst | heap rest | heap burst | worker skipped? | note |
|---|---:|---:|---:|---:|---|---|
| **bots** | **22** | **26** | **26** | **20** | yes `gatewayService` | 唯一清晰大头；discord.js 不进 boot |
| **networkProxy** | **6** | **9** | **8** | 0 | yes `networkProxyEngineSupervisor` | 无 mihomo 子进程；只是 supervisor 图 |
| **managedAi** | **6** | **5** | **7** | **5** | yes `aiCatalogReadiness` | 避开 G0b 的 ReferenceError 路径 |
| **branding** | **6** | 0 | 3→0 | 0 | yes `brandingAssetCleanup` | sharp 仍可能被 `user`/`platform` 拉进 |
| audit | 0 | 0 | 4 | 0 | yes `auditExport`,`auditRetention` | 省 CPU/xact，不省 RSS |
| managedConnectors | 0 | 0 | 0 | 0 | yes 4 workers | |
| managedAgents | 0 | 0 | 4 | 0 | yes `agentRollout` | |
| databaseIdp | 0 | 0 | 0 | 0 | yes 2 cleanup workers | |
| managedSkills | 0 | 0 | 0 | 0 | yes `skillCatalogReadiness` | |
| moderation | 0 | 0 | 0 | 0 | no | hot / 无 worker |
| chatgptWeb | 0 | 0 | 0 | 0 | no | |
| agentSignal | 0 | 0 | 0 | 0 | no | |
| imageGen | 0 | 0 | 0 | 0 | no | lazy |
| knowledgeBase | 0 | 0 | 0 | 0 | no | lazy |
| webSearch | 0 | 0 | 0 | 0 | no | lazy |
| memory | 0 | 0 | 0 | 0 | no | lazy |
| market | 0 | 0 | 0 | 0 | no | lazy |
| taskTemplates | 0 | 0 | 0 | 0 | no | lazy |
| platformStats | 0 | 0 | 0 | 0 | no | |
| settingsPolicy | 0 | 0 | 0 | 0 | no | |
| speech | 0 | 0 | 0 | 0 | no | lazy |
| workflows | 0 | 0 | 0 | 0 | no | |
| sandbox | 0 | 0 | 0 | 0 | no | |
| deviceGateway | 0 | 0 | 0 | 0 | no | r1 rest 217 离群，r2=276 |

**填 `cost.idleRssMb` 建议：** `bots=22`，`networkProxy=8`，`managedAi=6`，`branding=6`，其余 **0**（在 all-lazy + no-preload 下，hot 模块正确就是 0）。
