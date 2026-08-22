# 办公文件多模态解析(含排版)统一方案 — 设计稿 v2

> 状态:设计(2026-08-22),待实施。v1 的"上传时全量规范化 + LibreOffice 进主镜像"已被否决(太重)。v2 以**内容触发、分档处理、sidecar 可拆模块、按预算投喂**为原则,目标是让每个端点(ChatGPT Codex / ChatGPT Web / Grok Build(ZDR)/ SuperGrok / Cursor / 普通 API 服务商)都能"看到"带图办公文件的**内容和排版**,同时纯文字文件零额外开销,几十页的大 PPT 也可控。

---

## 1. 目标与非目标

**目标**
- 带图 / 带版式的 docx、pptx、xlsx、PDF(含扫描件)在所有端点可被模型理解,包括图在页面中的位置关系。
- 纯文字文件走现有文本路径,不触发任何渲染。
- 几十页以上的 PPT:一次对话只投喂预算内的页,模型可按需索取更多页。
- 渲染能力是**可拆模块**(sidecar),主镜像不变;管理员可开关、配置、监控。
- 上游前端零改动;企业侧代码承担全部逻辑。

**非目标**
- 不做通用 OCR 平台、不做文档编辑;旧二进制 .doc/.ppt 只抽文本;SmartArt/矢量图表以整页图形式呈现,不单独抽取。

---

## 2. 总体结构

```
 上传 ──► createFile ──► 前置判定(毫秒,主进程)
                            │
            ┌───────────────┼────────────────────┐
         纯文字           少量插图             图为主 / 版式重要
            │                │                      │
      文本抽取(已有)   文本 + OOXML 抽原图     文本 + 整页渲染任务(异步,sidecar)
                                                    │
                                             产物 → S3(pages@1800 / @512 / text / meta)
                                                    │
 发消息 ──► beforeChat 投喂选择器(读产物,按端点能力表 + 预算)
              ├─ 总览拼图(缩略 3×4,印页码)        ← 排版感知
              ├─ 精选整页(用户提及 / 相关度 / 图为主)
              ├─ 每页文本(带页码)
              └─ 工具 viewDocumentPages(fileId, pages[]) ← 模型按需放大
 智能体模式 ──► 附件同步进沙箱 + document-processing skill(自助升级处理)
```

---

## 3. 前置判定与分档(零成本,决定是否进厚流程)

| 格式 | 判定方法(主进程,毫秒级) | 档位 |
|---|---|---|
| docx / pptx / xlsx | 解 zip 目录:`word/media`、`ppt/media`、`xl/media`、`xl/charts`、`*/drawings`、`diagrams/` 的存在与数量;pptx 每页 rels 统计图/形状数 | 无 → **T0 纯文字**;少量(默认 `media < 3` 且非 pptx)→ **T1 抽原图**;其余 → **T2 整页渲染** |
| pdf | pdfjs 逐页:文本字数、XObject 图像数、页面文字密度 | 全页有字且无图 → T0;有扫描页/图为主页 → T2(仅渲这些页;已上线的光栅化即此路径) |
| txt / md / csv / html / 代码 | — | T0 |
| 旧 .doc / .ppt | officeparser 抽文本 | T0(不渲) |
| 图片 | — | 本身即一页 |

- pptx 默认直接 T2(幻灯片天然版式重要),可在管理端改为"按 media 数判定"。
- T2 只渲染**有视觉内容的页**;纯文字页保留文本不出图(`meta.pages[n].visual=false`)。
- 阈值全部可配置(见 §7)。
- 渲染触发时机可选:`onUpload`(上传即渲,默认)或 `onDemand`(首次有端点需要时投递任务,首轮以 T1 兜底)。

---

## 4. 产物(Artifacts)

存 S3,前缀 `files/<fileId>/render/`,按文件 `sha256` 去重(同一内容只渲一次,`files.metadata.renderHash` 指向);写入 `files.metadata.render`(jsonb,**无迁移**):

```jsonc
{
  "status": "pending" | "ready" | "partial" | "failed" | "skipped",
  "tier": "T0" | "T1" | "T2",
  "engine": "gotenberg@8.x" | "pdfjs" | "ooxml",
  "pageCount": 62,
  "renderedPages": [1,2,5,...],          // T2 仅视觉页
  "pages": { "1": { "visual": true, "chars": 120, "png1800": "…", "png512": "…" }, ... },
  "figures": [ { "page": 5, "key": "…/figures/5-1.png", "caption": "…" } ],   // T1 / 可选
  "sheets": [ { "name": "Q3", "text": "…" } ],                              // xlsx
  "error": null, "updatedAt": "…", "durationMs": 8400
}
```

- 整页 `@1800`(长边 ≤1800,投喂用)、缩略 `@512`(总览拼图用);密集页可额外存 2×2 切片(复用现有 `pdfPageImages` 切片逻辑)。
- 每页文本 `text/<n>.md`(现有 loaders 按页切分;pptx 每页含标题/要点/备注)。
- 产物随文件删除一并清理(前缀删除);可配置保留天数;配额并入文件配额。

---

## 5. 渲染 sidecar(模块 `documentRender`)

### 5.1 选型
- **Gotenberg**(内含 LibreOffice + Chromium,REST):`POST /forms/libreoffice/convert` Office → PDF;PDF → PNG 由现有 pdfjs 在 Worker 中完成(不依赖 Gotenberg 的截图)。
- 作为 Compose profile `document-render` 的独立容器;主镜像不变。未部署或模块关闭时自动退到 T1 + PDF 光栅化。

### 5.2 执行模型
- 任务进 `platform_jobs`(类型 `document.render`),由企业 worker 消费;worker 下载原文件 → 调用 sidecar → 渲页 → 上传产物 → 更新 `files.metadata.render`。
- 并发、超时、页数上限、单文件大小上限由设置决定(§7),默认并发 2、超时 120 s、≤200 页、≤32 MiB。
- 幂等:同 hash 已 ready 直接复用;失败可重试(指数退避,最多 3 次),仍失败置 `failed` 并保留文本路径。
- 安全:sidecar 只接收 worker 的内网请求;LibreOffice 禁宏、禁外链(Gotenberg 默认配置 + `--libreoffice-disable-routes` 按需);产物按 `userId/workspaceId` 鉴权;日志不含文件内容。

### 5.3 模块化(沿用 `docs/enterprise/modules.md` 机制)
- 新模块 id `documentRender`,`kind: hot`(开关即时生效,无需重启;worker 通过热视图判断是否消费任务),`tier: optional`,`cost: sidecar`。
- 关闭效果:不投递渲染任务、不调用 sidecar、投喂选择器只用 T0/T1 产物;已有产物仍可读(可配置是否继续使用)。
- env 可禁用:`LOBE_MODULES_DISABLED=documentRender`。

---

## 6. 管理员面板

### 6.1 模块开关
- `/admin/system/modules` 新增 `documentRender` 卡片(与沙箱、网络代理并列),显示依赖("需要 Gotenberg sidecar")与当前探测状态。

### 6.2 设置卡片(`/admin/system/general` → 「文档渲染」)
存储:单例表 `platform_document_render_settings`(`id='global'`,jsonb `config`,CAS `revision`,`updated_by`;迁移 `0028`)。DB ?? env 的有效值解析,沿用 `sandboxSettings` 的 `effective.ts` 模式。

| 设置 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://document-render:3000` | Gotenberg 地址(env `DOCUMENT_RENDER_URL` 兜底) |
| `trigger` | `onUpload` | `onUpload` / `onDemand` |
| `tierRules.pptxAlwaysT2` | true | pptx 直接整页渲染 |
| `tierRules.mediaThresholdT2` | 3 | docx/xlsx 媒体数 ≥ 阈值进 T2 |
| `limits.maxPages` | 200 | 超出只渲前 N 页并标注 |
| `limits.maxFileBytes` | 32 MiB | |
| `limits.concurrency` | 2 | worker 并发 |
| `limits.timeoutSec` | 120 | 单任务超时 |
| `render.longEdgePx` | 1800 | 整页 |
| `render.thumbEdgePx` | 512 | 缩略 |
| `render.tilesForDensePages` | true | 密集页 2×2 切片 |
| `feed.contactSheetGrid` | `3x4` | 总览拼图网格 |
| `feed.maxDocsPerRequest` | 2 | |
| `feed.maxImagesDefault` | 6 | 端点能力表可覆盖(Cursor 4) |
| `retention.days` | 0(随文件) | 产物保留 |
| 操作 | — | 「测试连接」(探测 sidecar 版本)、「重渲染失败任务」、「清理孤儿产物」 |

保存:`admin.documentRender.updateSettings`(`SYSTEM_OPERATE`,CAS,审计 `admin.documentRender.update`);读取:`admin.documentRender.getSettings`(`SYSTEM_READ`)。两者登记到安全/策略双注册表。

### 6.3 监控(`/admin/system/status` → 「文档渲染」区块 + 设置卡内摘要)
探测与统计(30 s 单飞 memo,沿用系统状态探测模式):
- **Sidecar 状态**:`GET /health` 结果、版本、延迟;模块关闭 / 未配置 / 不可达 三态。
- **队列**:pending / running / failed(24 h)计数,平均与 P95 耗时,最近 10 条任务(文件名脱敏为 id + 扩展名、页数、耗时、结果)。
- **产物占用**:产物总字节、文件数、最近清理时间。
- **投喂统计**(来自 `beforeChat` 钩子计数器):24 h 内按端点的"总览图 / 整页 / 工具放大"次数与图字节量,超预算降级次数。
- 操作:重试失败任务、取消排队任务。
- API:`admin.documentRender.getStatus`(`SYSTEM_READ`)、`retryJob` / `cancelJob`(`SYSTEM_OPERATE`)。

### 6.4 用户侧最小反馈
附件卡角标:`处理中 / 已就绪 / 未生成页面图(仅文本)`;不阻塞发送。

---

## 7. 投喂选择器(发消息时,主进程零渲染)

### 7.1 端点能力表(唯一按端点维护的配置)

| 端点 | 原生文件 | 视觉 | 图数上限 | 单图上限 | 工具调用 |
|---|---|---|---|---|---|
| ChatGPT Codex | 文档类(后端仅抽文本) | ✅ | 6 | 20 MiB | ✅ |
| ChatGPT Web | 上传(自带 OCR/渲染) | ✅ | 6 | — | ✅ |
| Grok Build | ❌(ZDR) | ✅ | 6 | 20 MiB | ✅ |
| SuperGrok | Files API(无 Office) | ✅ | 6 | 20 MiB | ✅ |
| Cursor | ❌ | ✅ | 4 | 6 MiB | ❌ |
| 普通 API 服务商 | `abilities.files` | `abilities.vision` | 模型卡 | 模型卡 | 模型卡 |

### 7.2 规则
1. **文本层始终发送**:每页文本带页码;T0 文件到此为止。
2. **原生文件可用**:发原生文件 + 文本;若 `hasTextLayer=false` 再附整页图(原生接口不渲染扫描件)。
3. **有视觉的端点**(核心路径):
   - 总览拼图:`@512` 缩略按 `contactSheetGrid` 拼接,每格印页码;60 页 ≈ 5 张;`detail: low`。
   - 精选整页(`detail: high`),预算 = 图数上限 − 总览图数,优先级:用户提及的页码/章节 → 与当前问题相关度最高的页(按页文本检索)→ 图为主页 → 首页/目录页;密集页附切片。
   - 其余页在文本中标注 `[第 n 页含图,未附;可要求查看]`。
4. **纯文本端点**:文本 + `[第 n 页含 k 张图,已省略]`。
5. **预算**:每请求 ≤`maxDocsPerRequest` 个文档参与图投喂;图只随最后一条用户消息发送;历史轮次保留文本与"已查看页"记录。
6. **提示语模板**(统一,防"工具重读"):`[文档 "<name>":共 N 页,文字层:有/无;已附总览图 k 张与第 i…j 页整页图;需要其它页请调用 viewDocumentPages 或说明页码]`。

### 7.3 按需放大工具 `viewDocumentPages`
- 内置工具(builtin-tool),参数 `{ fileId, pages: number[] (≤4), zoom?: 'page'|'tiles' }`,返回对应整页图(或切片)作为图片结果;受同一预算与鉴权约束;每轮最多调用 3 次。
- 对无工具的端点(Cursor)不注册,靠 7.2 的精选。
- 产物缺失时工具触发按需渲染任务并返回"处理中,请稍后再试"。

---

## 8. 智能体模式:沙箱 + skill(补足上限)
- 所有附件同步进 `/mnt/data/uploads/<name>-<fileId>`(去掉"仅超限"条件),`<files_info>` 标 `sandboxPath`;同步失败不影响投喂(已修复)。
- 内置 `document-processing` skill:描述写成触发条件("附带/询问 PDF、Office、压缩包、未知二进制,或需要更多页、OCR、抽表时");正文:`file` 判类型 → `pip install python-pptx/pypdf/...`(沙箱可自装)→ 转文本/图 → `exportFile` 或直接回图。沙箱镜像不预装 LibreOffice;整页渲染仍由 sidecar 承担。
- Cursor 端点无 shell,不适用本层。

---

## 9. 失败与退化矩阵

| 情况 | 行为 |
|---|---|
| 模块关闭 / sidecar 未配置 | 不投递任务;T2 文件按 T1(抽原图)+ 文本投喂;PDF 扫描件仍走已有光栅化 |
| sidecar 不可达 / 超时 | 任务失败重试 3 次;期间按 T1 投喂;状态页告警 |
| 超页数 / 超大小 | 渲前 N 页并标注;超大小直接 `skipped` |
| 产物未就绪时发送 | 本轮 T1 + 文本;下一轮自动用上产物 |
| 端点预算不足 | 降级为总览图 + 文本,提示可索取页码 |
| ZDR / 原生文件被拒 | 与今日一致:文本 + 图 |

---

## 10. 数据模型与接口汇总

- `files.metadata.render`(jsonb,无迁移)。
- 新表 `platform_document_render_settings`(迁移 0028,单例 + CAS)。
- `platform_jobs` 新任务类型 `document.render`(payload `{ fileId, hash, tier, pages? }`)。
- tRPC `admin.documentRender.{getSettings,updateSettings,getStatus,retryJob,cancelJob,testConnection}`(权限 `SYSTEM_READ` / `SYSTEM_OPERATE`,双注册表登记,审计动作 `admin.documentRender.*`)。
- 内置工具 `viewDocumentPages`。
- 模块 id `documentRender`(`packages/const/src/platform/modules.ts`,`kind: hot`,文档表格重新生成)。
- Compose profile `document-render`:`gotenberg/gotenberg:8`,内网端口 3000,资源限制 1 CPU / 1 GiB(可调)。

---

## 11. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0(已完成) | PDF 光栅化 + 密集页切片、`<files_info>` 路径、预算与并发上界、能力按运行时 provider、同步失败保留 file_url | 扫描名片 PDF 四端可读 |
| P1 | 前置判定与分档(T0/T1/T2)、OOXML 抽原图(T1)、智能体模式附件全量同步 + `document-processing` skill、能力表加入普通 API 服务商 | 带少量插图的 Word 四端可读;纯文字文件无额外开销 |
| P2 | `documentRender` 模块 + Gotenberg profile + 渲染 worker + 产物;管理端开关/设置卡/状态监控/测试连接 | 60 页 PPT 上传后产物就绪;状态页可见队列与 sidecar 健康 |
| P3 | 投喂选择器:总览拼图 + 精选整页 + 提示语;`viewDocumentPages` 工具;用户侧角标 | 60 页 PPT 在 Codex/Grok/SuperGrok/Cursor 可按版式理解并按需放大 |
| P4 | 相关度检索挑页、产物保留/清理策略、投喂统计、重渲/清理操作 | 成本与运维闭环 |

每阶段遵循"先 demo 真机跑通,再交 codex 复审"。

---

## 12. 已知取舍
- 整页渲染依赖 LibreOffice 的版式保真(复杂动画、特殊字体可能失真),但对"看清图文关系"足够。
- 总览拼图用低清缩略,细节靠精选整页和工具放大;无工具端点(Cursor)只能靠启发式挑页。
- 模型是否真正利用附图取决于其行为;统一提示语与 skill 用于收敛,不能保证百分百。
- T2 渲染有秒级延迟,`onUpload` 触发下几乎无感;`onDemand` 首轮无版式。
