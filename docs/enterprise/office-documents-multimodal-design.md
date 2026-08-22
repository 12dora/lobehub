# 各端点解析常见办公文件(含图片)的统一方案 — 设计稿

> 状态:设计(2026-08-22),未实施。背景:名片 PDF 批次证明"按格式 × 端点临场适配"不可持续;带图片的 Office 文件(图为主的 PPT、带图表的 Word/Excel、扫描件嵌入 Word)目前只剩抽取文本,图片信息全部丢失。

## 1. 目标与范围

- 覆盖格式:PDF(含扫描件)、doc/docx、ppt/pptx、xls/xlsx/csv、rtf/odt/odp/ods、txt/md/html、图片;压缩包与未知二进制交给沙箱层。
- 覆盖端点:ChatGPT Codex、ChatGPT Web、Grok Build(ZDR)、SuperGrok、Cursor,以及任何普通 API 服务商(OpenAI/Anthropic/…)。
- 核心约束:**图片内容不能丢**(幻灯片配图、Word 插图、Excel 图表、扫描页);主服务进程不承担重 CPU;新格式/新端点只改一处。

## 2. 总体结构:两层 + 一张能力表

```
                ┌──────────────── 上传时(异步,Worker)────────────────┐
  任意附件 ──►  │ 规范化管线 → 产物(S3):text / pages / figures /    │
                │                      tables / meta                   │
                └──────────────────────────────────────────────────────┘
                                   │
  发消息时(beforeChat 钩子,主进程,零转换)
                                   ▼
                ┌──────── 投喂选择器(按端点能力表 + 预算)────────┐
                │ 原生文件 │ 页面图+插图 │ 文本+表格 │ 沙箱路径     │
                └──────────────────────────────────────────────────┘
                                   │
  智能体模式:附件全量同步进沙箱 + 文档处理 skill(模型自助升级处理)
```

- **第 1 层(规范化产物)**保证每个端点、每种模式都"看得见"内容。
- **第 2 层(沙箱 + skill)**保证智能体模式下"做得了"复杂处理(多页、OCR 重跑、抽表、解压、未知二进制)。
- **能力表**决定投喂方式,是唯一需要按端点维护的地方(一行一个端点)。

## 3. 第 1 层:上传时规范化

### 3.1 产物定义(挂在 `files` 行,存 S3,按文件哈希缓存)

| 产物 | 内容 | 生成方式 |
|---|---|---|
| `text` | 全文文本,按页/幻灯片/工作表分段,带 `<page n>` 锚点 | 现有 `file-loaders`(mammoth / officeparser / SheetJS / pdfjs);扫描页用 OCR 补齐,并标记 `ocr:true` |
| `pages[]` | 每页渲染 PNG(长边 ≤1800,密集页另存 2×2 两倍切片) | Office → LibreOffice headless 转 PDF → pdfjs 渲染(复用现有 `pdfPageImages`);PDF 直接渲染;图片即一页 |
| `figures[]` | 文档内嵌图片原件(docx `word/media/*`、pptx `ppt/media/*`、xlsx 图表导出 PNG),附带所在页号与邻近标题/说明文字 | 直接从 OOXML zip 抽取;xlsx 图表经 LibreOffice 渲染 |
| `tables[]` | 结构化表格(CSV/JSON) | SheetJS / docx 表格解析 |
| `meta` | 页数、是否有文字层、每页文字密度、语言、总大小、产物大小 | 规范化过程中统计 |

**为什么既要 `pages` 又要 `figures`**:页面图保留版式与上下文(图在哪一页、旁边写了什么),插图原件保留分辨率(幻灯片里的小图渲成页面图后常不可读)。投喂时默认给页面图,当页内有插图且文字密度低(图为主)时附插图原件。

### 3.2 执行位置与资源

- 在 **规范化 Worker** 里跑:复用沙箱镜像(`aihub-sandbox`)作为 converter 容器,或独立 `aihub-converter` 镜像;通过现有 `platform_jobs` 队列异步执行,主进程只投递任务。
- 镜像预装:LibreOffice headless、poppler、tesseract(中英)、python 生态(pdfplumber、python-docx、python-pptx、openpyxl)。体积约 +400 MB,可接受。
- 预算:单文件 ≤32 MiB;页面图 ≤50 页(超出只渲前 50 页并在 `meta` 标注);单任务超时 120 s;并发由队列控制(默认 2)。
- 幂等:按 `sha256(文件)` 缓存产物,重复上传/多话题复用不重算。

### 3.3 UI 与生命周期

- 上传后附件卡显示"处理中 / 可用 / 失败(仍可发送,仅文本)";发送不阻塞,产物未就绪时按当时可用的最优投喂。
- 产物随文件删除而删除;配额与文件配额合并计算。

## 4. 投喂选择器(发消息时)

### 4.1 端点能力表(唯一按端点维护的地方)

| 端点 | 原生文件 | 视觉 | 图数上限 | 单图上限 | 备注 |
|---|---|---|---|---|---|
| ChatGPT Codex | ✅ 文档类(仅抽文本) | ✅ | 6 | 20 MiB | 后端不渲染 PDF,图片必须我们给 |
| ChatGPT Web | ✅ 上传(自带 OCR/渲染) | ✅ | 6 | — | 原生即可,页面图可选 |
| Grok Build | ❌(ZDR) | ✅ | 6 | 20 MiB | 只能文本 + 图 |
| SuperGrok | ✅ Files API(txt/md/pdf/csv/json/代码) | ✅ | 6 | 20 MiB | Office 不在列表 → 文本 + 图 |
| Cursor | ❌ | ✅ | 4 | 6 MiB | 无 shell,只吃文本 + 图 |
| 普通 API 服务商 | 视 `abilities.files` | 视 `abilities.vision` | 按卡 | 按卡 | 同一套逻辑,只需加入钩子名单 |

### 4.2 选择规则(按优先级)

1. 端点支持该格式的原生文件 → 发原生文件 **+** `text`(兜底);若 `meta.hasTextLayer=false` 再附 `pages`(原生接口不渲染扫描件)。
2. 否则有视觉 → `text` + `pages`(按预算挑页:优先用户提及的页、图为主的页、首页;密集页附切片)+ 图为主页的 `figures` 原件。
3. 否则(纯文本模型)→ `text` + OCR 文本 + `tables`,并在文本里标注"[第 n 页含 k 张图,已省略]"。
4. 预算:每请求 ≤2 个文档参与图投喂、图总数按能力表、总字节 ≤ 端点上限;超出部分降级为文本并提示模型可"要求查看第 n 页"(智能体模式下由 skill 兑现)。
5. 只对最后一条用户消息做图投喂;历史轮次保留文本,避免 token 与带宽膨胀。

### 4.3 提示语约定(防"工具重读")

统一模板:`[文档 "<name>":共 N 页,文字层:有/无;已附第 i…j 页的页面图与 k 张插图;需要其它页请说明页码]`。`<files_info>` 内该文件正文为文本产物;扫描件正文为空时改为上述说明,避免模型用工具重读空文本。

## 5. 第 2 层:沙箱 + 文档处理 skill(智能体模式)

- **全量同步**:智能体模式下所有附件(不只超限)同步到 `/mnt/data/uploads/<name>-<fileId>`,并在 `<files_info>` 标 `sandboxPath`;同步失败不影响第 1 层投喂(已修:失败不再丢 `file_url`)。
- **沙箱镜像补工具**:与规范化 Worker 同一镜像,保证 skill 脚本可跑。
- **内置 skill `document-processing`**:description 写成触发条件("用户附带或询问 PDF / Office / 压缩包 / 未知二进制,或要求看某一页、抽表、OCR 时使用");正文给标准流程:`file` 判类型 → `pdftoppm -r 200 -png` / `soffice --headless --convert-to pdf` / `unzip` / `python -m …` → 用 `exportFile` 或直接把图片交回对话。与官方客户端"自动调用 skill"同一原理:渐进披露 + 工作区文件 + 预装依赖。
- Cursor 端点不适用本层(`--mode ask` 无 shell),始终依赖第 1 层。

## 6. 安全与隔离

- 所有转换在容器内执行,文件来自 S3 只读挂载/下载,输出写回产物桶;LibreOffice 禁宏、禁外链(`--norestore --nolockcheck`、`-env:UserInstallation` 隔离)。
- 产物按 `userId`/`workspaceId` 鉴权,投喂只解析 `/f/<id>`(不碰裸 S3 URL,沿用现有规则)。
- 不把产物或原文写进日志;页面图 data URI 只在请求体内,不落盘主进程。

## 7. 分阶段落地

| 阶段 | 内容 | 覆盖 |
|---|---|---|
| P0(已完成) | PDF 光栅化 + 切片、`<files_info>` 路径、能力按运行时 provider、同步失败保留 file_url | 扫描 PDF 四端可读 |
| P1 | 智能体模式附件全量同步;沙箱镜像补 LibreOffice/poppler/tesseract/python 库;`document-processing` skill | 任意文件在智能体模式可处理 |
| P2 | 规范化 Worker + 产物存储 + 上传态 UI;投喂选择器读产物(先 PDF/图片,后 Office) | 所有端点/模式看得见 Office 内图 |
| P3 | OCR 文字层、`figures` 抽取与图为主页判定、密集页切片策略、预算与缓存治理 | 质量与成本 |

## 8. 已知取舍

- 镜像体积与转换耗时换来"端点无关";若部署不愿装 LibreOffice,可用模块开关降级到"仅文本 + PDF 光栅化"。
- Office → PDF 的版式保真度依赖 LibreOffice(复杂 PPT 动画、SmartArt 可能失真),但对"看清图和文字"足够。
- 模型是否真的利用附图仍取决于其行为;提示语约定与 skill 引导用于收敛,但不能保证百分百。
