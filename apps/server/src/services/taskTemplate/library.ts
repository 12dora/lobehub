import type {
  InterestAreaKey,
  TaskTemplate,
  TaskTemplateCategory,
  TaskTemplateConnector,
} from '@lobechat/const';

/**
 * Bundled task-template library.
 *
 * The upstream market recommendations mix work templates with personal-life ones (bedtime
 * gratitude, parenting …). This enterprise build ships its own curated, work-only library
 * covering the functions a company actually runs — R&D, manufacturing, sales, management,
 * marketing, product, operations, HR, finance / legal — so both the home-page recommendations
 * (when the platform catalog is empty) and the admin "import" pull from the same local source
 * and never depend on an outbound market call.
 *
 * Every entry is a plain scheduled prompt (no connectors required) so it works on any deployment.
 */

export type TaskTemplateLibraryLocale = 'en-US' | 'zh-CN';

interface LocalizedTaskTemplateText {
  description: string;
  instruction: string;
  title: string;
}

export interface TaskTemplateLibraryEntry {
  category: TaskTemplateCategory;
  connectors: TaskTemplateConnector[];
  cronPattern: string;
  /** Stable numeric id — used by the home page as a React key and for excludeIds. */
  id: number;
  identifier: string;
  interests: InterestAreaKey[];
  text: Record<TaskTemplateLibraryLocale, LocalizedTaskTemplateText>;
}

const entry = (
  id: number,
  identifier: string,
  category: TaskTemplateCategory,
  interests: InterestAreaKey[],
  cronPattern: string,
  zh: LocalizedTaskTemplateText,
  en: LocalizedTaskTemplateText,
): TaskTemplateLibraryEntry => ({
  category,
  connectors: [],
  cronPattern,
  id,
  identifier,
  interests,
  text: { 'en-US': en, 'zh-CN': zh },
});

export const TASK_TEMPLATE_LIBRARY: readonly TaskTemplateLibraryEntry[] = [
  // ───────────────────────────── 研发 / Engineering ─────────────────────────────
  entry(
    1001,
    'eng-daily-standup-brief',
    'engineering',
    ['coding', 'product'],
    '30 9 * * 1,2,3,4,5',
    {
      description: '每个工作日早晨，整理昨日进展、今日计划与阻塞项，生成可直接粘贴到站会的简报。',
      instruction:
        '每个工作日 09:30，请根据我提供或近期讨论过的任务，整理一份站会简报：昨日完成、今日计划、当前阻塞与需要的协助。每项一行，控制在 10 行以内，末尾列出需要负责人拍板的事项。',
      title: '研发站会简报',
    },
    {
      description:
        'Every weekday morning, summarise yesterday, today and blockers into a paste-ready stand-up brief.',
      instruction:
        'Every weekday at 09:30, compile a stand-up brief from the tasks I shared or we recently discussed: done yesterday, planned today, current blockers and help needed. One line per item, at most 10 lines, ending with decisions that need an owner.',
      title: 'Engineering stand-up brief',
    },
  ),
  entry(
    1002,
    'eng-code-review-checklist',
    'engineering',
    ['coding'],
    '0 10 * * 1,2,3,4,5',
    {
      description: '每个工作日上午，提醒并生成当天待评审代码的评审要点清单，避免遗漏安全与性能项。',
      instruction:
        '每个工作日 10:00，请提醒我处理待评审的代码变更，并按以下维度输出评审清单：正确性、边界条件、错误处理、安全（输入校验、权限、敏感信息）、性能与可维护性、测试覆盖。对我粘贴的变更给出具体评审意见与建议的合并结论。',
      title: '代码评审清单',
    },
    {
      description:
        'Every weekday morning, remind you of pending reviews and generate a review checklist covering security and performance.',
      instruction:
        'Every weekday at 10:00, remind me to handle pending code reviews and produce a checklist covering correctness, edge cases, error handling, security (input validation, authorisation, secrets), performance / maintainability and test coverage. For any diff I paste, give concrete review comments and a merge recommendation.',
      title: 'Code review checklist',
    },
  ),
  entry(
    1003,
    'eng-release-notes-weekly',
    'engineering',
    ['coding', 'writing', 'product'],
    '0 16 * * 5',
    {
      description: '每周五下午，把本周合并的变更整理成面向业务方可读的发布说明。',
      instruction:
        '每周五 16:00，请根据我提供的本周变更列表（提交、工单或需求编号），整理一份发布说明：新增功能、优化、缺陷修复、已知问题与升级注意事项。使用业务方能看懂的语言，避免内部术语，每条注明影响范围。',
      title: '每周发布说明',
    },
    {
      description:
        'Every Friday afternoon, turn this week’s merged changes into release notes readable by business stakeholders.',
      instruction:
        'Every Friday at 16:00, turn the list of changes I provide (commits, tickets or requirement ids) into release notes: new features, improvements, bug fixes, known issues and upgrade notes. Write for business readers, avoid internal jargon and state the impact scope of each item.',
      title: 'Weekly release notes',
    },
  ),
  entry(
    1004,
    'eng-incident-review-weekly',
    'engineering',
    ['coding', 'operations'],
    '0 15 * * 1',
    {
      description: '每周一下午，回顾上周线上告警与故障，形成根因、改进项与责任人清单。',
      instruction:
        '每周一 15:00，请根据我提供的上周告警与故障记录，输出一份复盘：按影响程度排序的事件列表、每个事件的时间线、根因、临时措施与长期改进项（含建议负责人与期限）。最后归纳可复用的预防措施。',
      title: '线上故障周复盘',
    },
    {
      description:
        'Every Monday afternoon, review last week’s alerts and incidents into root causes, action items and owners.',
      instruction:
        'Every Monday at 15:00, using the alert and incident records I provide, write a retrospective: incidents ranked by impact, a timeline for each, root cause, mitigation and long-term fixes (with suggested owner and due date). Close with reusable prevention measures.',
      title: 'Weekly incident review',
    },
  ),
  entry(
    1005,
    'eng-tech-debt-review',
    'engineering',
    ['coding', 'product'],
    '0 14 * * 3',
    {
      description: '每周三下午，梳理技术债清单，评估影响与偿还成本，给出下个迭代的建议。',
      instruction:
        '每周三 14:00，请帮我更新技术债清单：对我提供的条目按影响（稳定性 / 安全 / 效率）与偿还成本分级，标出应纳入下个迭代的 3 项，并给出每项的最小可行改进方案。',
      title: '技术债评审',
    },
    {
      description:
        'Every Wednesday afternoon, groom the tech-debt backlog, rate impact vs. cost and propose items for the next sprint.',
      instruction:
        'Every Wednesday at 14:00, help me groom the tech-debt backlog: grade the items I provide by impact (stability / security / efficiency) and cost to fix, flag the 3 that belong in the next sprint and give a minimal viable fix for each.',
      title: 'Tech-debt review',
    },
  ),
  // ───────────────────────────── 制造 / Manufacturing ─────────────────────────────
  entry(
    1101,
    'mfg-daily-production-report',
    'operations',
    ['operations', 'business'],
    '0 8 * * 1,2,3,4,5,6',
    {
      description: '每天早晨，根据前一日产线数据生成生产日报：产量、达成率、停机与异常。',
      instruction:
        '每天 08:00，请根据我提供的前一日产线数据（计划产量、实际产量、停机时长、不良数），生成生产日报：各产线达成率、主要停机原因、异常波动与建议关注点。用表格呈现关键指标，异常项加粗。',
      title: '生产日报',
    },
    {
      description:
        'Every morning, turn yesterday’s line data into a production report: output, attainment, downtime and anomalies.',
      instruction:
        'Every day at 08:00, using yesterday’s line data I provide (planned output, actual output, downtime, defects), produce a production report: attainment per line, top downtime causes, abnormal swings and points to watch. Present key metrics in a table with anomalies in bold.',
      title: 'Daily production report',
    },
  ),
  entry(
    1102,
    'mfg-quality-defect-weekly',
    'operations',
    ['operations'],
    '0 9 * * 1',
    {
      description: '每周一早晨，汇总上周质量数据，做不良帕累托分析并给出改善建议。',
      instruction:
        '每周一 09:00，请根据我提供的上周质检数据，输出质量周报：不良率趋势、按不良类型的帕累托排序、前三大问题的可能原因与改善措施建议、需要跟踪的纠正预防措施。',
      title: '质量周报与不良分析',
    },
    {
      description:
        'Every Monday morning, summarise last week’s quality data with a defect Pareto and improvement actions.',
      instruction:
        'Every Monday at 09:00, using last week’s inspection data I provide, write a quality report: defect-rate trend, a Pareto ranking of defect types, likely causes and improvement actions for the top three, and the corrective actions to track.',
      title: 'Weekly quality & defect analysis',
    },
  ),
  entry(
    1103,
    'mfg-equipment-maintenance-plan',
    'operations',
    ['operations'],
    '0 10 * * 1',
    {
      description: '每周一上午，根据设备台账与运行时长，输出本周预防性维护计划与备件提醒。',
      instruction:
        '每周一 10:00，请根据我提供的设备台账（设备、上次保养日期、保养周期、运行时长），列出本周到期与即将到期的保养任务、建议排期、所需备件与注意事项，并标出超期未保养的设备。',
      title: '设备保养计划',
    },
    {
      description:
        'Every Monday morning, produce this week’s preventive-maintenance schedule and spare-part reminders from the equipment ledger.',
      instruction:
        'Every Monday at 10:00, using the equipment ledger I provide (asset, last service date, interval, running hours), list the maintenance due or coming due this week, a suggested schedule, required spares and precautions, and flag overdue equipment.',
      title: 'Equipment maintenance plan',
    },
  ),
  entry(
    1104,
    'mfg-inventory-shortage-check',
    'operations',
    ['operations', 'business'],
    '30 8 * * 1,2,3,4,5',
    {
      description: '每个工作日早晨，对照生产计划检查物料库存，提前预警短缺与呆滞料。',
      instruction:
        '每个工作日 08:30，请根据我提供的物料库存与近两周生产计划，找出可能短缺的物料（含预计缺口日期与建议采购量）以及长期无消耗的呆滞物料，输出预警清单并按紧急程度排序。',
      title: '物料短缺预警',
    },
    {
      description:
        'Every weekday morning, check material stock against the production plan and flag shortages and dead stock early.',
      instruction:
        'Every weekday at 08:30, using the stock levels and two-week production plan I provide, identify materials likely to run short (with expected shortfall date and suggested order quantity) and slow-moving dead stock. Output a warning list ordered by urgency.',
      title: 'Material shortage alert',
    },
  ),
  entry(
    1105,
    'mfg-safety-inspection-checklist',
    'operations',
    ['operations', 'hr'],
    '0 8 * * 1',
    {
      description: '每周一早晨，生成本周车间安全巡检清单与上周隐患整改跟踪。',
      instruction:
        '每周一 08:00，请生成本周车间安全巡检清单（消防、用电、机械防护、化学品、劳保用品、通道与标识），并根据我提供的上周隐患记录列出整改跟踪状态与逾期项。',
      title: '安全巡检清单',
    },
    {
      description:
        'Every Monday morning, generate this week’s shop-floor safety inspection checklist and track last week’s hazards.',
      instruction:
        'Every Monday at 08:00, generate this week’s shop-floor safety inspection checklist (fire, electrical, machine guarding, chemicals, PPE, walkways and signage) and, from the hazard records I provide, list last week’s corrective actions with status and overdue items.',
      title: 'Safety inspection checklist',
    },
  ),
  // ───────────────────────────── 销售 / Sales ─────────────────────────────
  entry(
    1201,
    'sales-pipeline-weekly',
    'sales-customer',
    ['sales', 'business'],
    '0 9 * * 1',
    {
      description: '每周一早晨，梳理销售管道：各阶段商机、预计成交、停滞商机与本周跟进重点。',
      instruction:
        '每周一 09:00，请根据我提供的商机列表（客户、阶段、金额、预计成交日、上次跟进），生成管道周报：各阶段金额与数量、本月预计成交、超过 14 天未跟进的停滞商机、本周必须跟进的 5 个重点客户及建议动作。',
      title: '销售管道周报',
    },
    {
      description:
        'Every Monday morning, review the sales pipeline: deals per stage, forecast, stalled deals and this week’s follow-ups.',
      instruction:
        'Every Monday at 09:00, using the opportunity list I provide (account, stage, amount, expected close, last touch), produce a pipeline report: amount and count per stage, this month’s forecast, deals untouched for over 14 days, and the 5 accounts to follow up this week with suggested actions.',
      title: 'Weekly sales pipeline review',
    },
  ),
  entry(
    1202,
    'sales-customer-followup-daily',
    'sales-customer',
    ['sales'],
    '30 8 * * 1,2,3,4,5',
    {
      description: '每个工作日早晨，列出今日需跟进的客户，并为每个客户起草跟进话术。',
      instruction:
        '每个工作日 08:30，请根据我提供的客户跟进记录，列出今天到期或应跟进的客户，并为每个客户起草一段简短、有针对性的跟进消息（提及上次沟通要点与下一步建议）。',
      title: '客户跟进提醒',
    },
    {
      description:
        'Every weekday morning, list the customers due for follow-up today and draft a tailored message for each.',
      instruction:
        'Every weekday at 08:30, using the follow-up records I provide, list the customers due today and draft a short, targeted follow-up message for each (referencing the last conversation and proposing the next step).',
      title: 'Customer follow-up reminder',
    },
  ),
  entry(
    1203,
    'sales-proposal-quote-review',
    'sales-customer',
    ['sales', 'writing'],
    '0 14 * * 1,2,3,4,5',
    {
      description: '每个工作日下午，审阅待发出的方案与报价，检查条款、折扣与风险点。',
      instruction:
        '每个工作日 14:00，请提醒我审阅待发出的方案与报价。对我粘贴的内容检查：客户需求是否覆盖、价格与折扣是否符合授权、付款与交付条款是否明确、法律与风险条款是否缺失，并给出修改建议与一段更有说服力的价值陈述。',
      title: '方案与报价审阅',
    },
    {
      description:
        'Every weekday afternoon, review outgoing proposals and quotes for terms, discounts and risk points.',
      instruction:
        'Every weekday at 14:00, remind me to review outgoing proposals and quotes. For the content I paste, check that customer requirements are covered, pricing and discounts are within authority, payment and delivery terms are explicit and legal / risk clauses are present; suggest edits and a stronger value statement.',
      title: 'Proposal & quote review',
    },
  ),
  entry(
    1204,
    'sales-win-loss-monthly',
    'sales-customer',
    ['sales', 'business'],
    '0 10 * * 1',
    {
      description: '每周一上午，回顾近期成交与丢单原因，提炼可复用的打法与需要改进的环节。',
      instruction:
        '每周一 10:00，请根据我提供的近期成交与丢单记录，做赢单 / 丢单分析：按原因分类统计、竞争对手出现频率、成交周期、可复用的成功打法与需要改进的环节，并给出下阶段的 3 条建议。',
      title: '赢单丢单分析',
    },
    {
      description:
        'Every Monday morning, review recent wins and losses to extract repeatable plays and improvement areas.',
      instruction:
        'Every Monday at 10:00, using the recent win / loss records I provide, run a win-loss analysis: reasons by category, competitor frequency, sales-cycle length, repeatable winning plays and weak spots, plus 3 recommendations for the next period.',
      title: 'Win / loss analysis',
    },
  ),
  entry(
    1205,
    'cs-ticket-digest-daily',
    'sales-customer',
    ['sales', 'operations'],
    '0 18 * * 1,2,3,4,5',
    {
      description: '每个工作日傍晚，汇总当天客户工单：数量、分类、未解决与升级项，并起草回复模板。',
      instruction:
        '每个工作日 18:00，请根据我提供的当天客户工单，输出摘要：新增 / 关闭数量、按问题类型分布、超时未响应与需升级的工单、重复出现的问题及根因线索，并为最常见的 3 类问题各起草一段回复模板。',
      title: '客户工单日报',
    },
    {
      description:
        'Every weekday evening, summarise the day’s support tickets: volume, categories, open escalations and reply templates.',
      instruction:
        'Every weekday at 18:00, using the day’s tickets I provide, write a digest: opened / closed counts, distribution by issue type, overdue and escalated tickets, recurring issues with root-cause hints, and a reply template for each of the 3 most common issues.',
      title: 'Daily support ticket digest',
    },
  ),
  // ───────────────────────────── 管理 / Management ─────────────────────────────
  entry(
    1301,
    'mgmt-weekly-report-draft',
    'business',
    ['business', 'writing'],
    '0 17 * * 5',
    {
      description: '每周五下午，把本周要点整理成一份结构化的部门周报草稿。',
      instruction:
        '每周五 17:00，请根据我提供的本周要点，起草部门周报：本周成果（量化）、进行中的事项与进度、风险与需要的支持、下周计划。语言简洁、结论先行，控制在一页以内。',
      title: '部门周报草稿',
    },
    {
      description:
        'Every Friday afternoon, turn this week’s notes into a structured department weekly report draft.',
      instruction:
        'Every Friday at 17:00, using the notes I provide, draft the department weekly report: quantified results, work in progress with status, risks and support needed, next week’s plan. Concise, conclusions first, one page at most.',
      title: 'Department weekly report draft',
    },
  ),
  entry(
    1302,
    'mgmt-okr-progress-check',
    'business',
    ['business', 'product'],
    '0 10 * * 5',
    {
      description: '每周五上午，检查团队 OKR 进展，标出偏离目标的关键结果并提出纠偏动作。',
      instruction:
        '每周五 10:00，请根据我提供的 OKR 及最新数据，评估每个关键结果的进度与置信度，标出落后于时间进度的项，分析原因并给出下周可执行的纠偏动作。以表格呈现，落后项加粗。',
      title: 'OKR 进展检查',
    },
    {
      description:
        'Every Friday morning, check OKR progress, flag key results that are off track and propose corrective actions.',
      instruction:
        'Every Friday at 10:00, using the OKRs and latest figures I provide, assess progress and confidence for each key result, flag items behind schedule, analyse why and propose concrete corrective actions for next week. Present as a table with off-track items in bold.',
      title: 'OKR progress check',
    },
  ),
  entry(
    1303,
    'mgmt-meeting-minutes-actions',
    'business',
    ['business', 'writing'],
    '0 18 * * 1,2,3,4,5',
    {
      description: '每个工作日傍晚，把当天会议记录整理为决议、行动项与责任人清单。',
      instruction:
        '每个工作日 18:00，请提醒我整理当天的会议记录。对我粘贴的记录，输出：会议结论、行动项（负责人、期限）、待决问题与下次会议议题，并生成一段可直接发送给与会者的纪要。',
      title: '会议纪要与行动项',
    },
    {
      description:
        'Every weekday evening, turn the day’s meeting notes into decisions, action items and owners.',
      instruction:
        'Every weekday at 18:00, remind me to process the day’s meeting notes. For the notes I paste, output decisions, action items (owner, due date), open questions and topics for the next meeting, plus a summary ready to send to attendees.',
      title: 'Meeting minutes & action items',
    },
  ),
  entry(
    1304,
    'mgmt-project-risk-weekly',
    'business',
    ['business', 'product', 'operations'],
    '0 9 * * 2',
    {
      description: '每周二早晨，更新项目风险登记册：新增风险、等级变化与应对措施。',
      instruction:
        '每周二 09:00，请根据我提供的项目进展与问题，更新风险登记册：新增风险（描述、可能性、影响、等级）、既有风险的等级变化、应对措施与责任人，并列出本周需要向上汇报的高风险项。',
      title: '项目风险周更新',
    },
    {
      description:
        'Every Tuesday morning, update the project risk register: new risks, rating changes and mitigations.',
      instruction:
        'Every Tuesday at 09:00, using the project status and issues I provide, update the risk register: new risks (description, likelihood, impact, rating), rating changes on existing risks, mitigations with owners, and the high risks to escalate this week.',
      title: 'Weekly project risk update',
    },
  ),
  // ───────────────────────────── 市场 / Marketing ─────────────────────────────
  entry(
    1401,
    'mkt-competitor-watch-weekly',
    'marketing',
    ['marketing', 'product', 'business'],
    '0 9 * * 1',
    {
      description: '每周一早晨，汇总主要竞争对手的产品、定价与市场动作，提炼对我们的启示。',
      instruction:
        '每周一 09:00，请根据我提供的 3–5 个竞争对手信息（产品更新、定价、活动、招聘、舆情），整理竞品动态周报：按对手分节、标出值得关注的动作、分析对我们的影响与建议应对。',
      title: '竞品动态周报',
    },
    {
      description:
        'Every Monday morning, summarise competitors’ product, pricing and market moves and what they mean for us.',
      instruction:
        'Every Monday at 09:00, using the information I provide on 3–5 competitors (product updates, pricing, campaigns, hiring, press), write a competitor digest: one section per competitor, notable moves highlighted, impact on us and suggested responses.',
      title: 'Weekly competitor digest',
    },
  ),
  entry(
    1402,
    'mkt-campaign-performance-weekly',
    'marketing',
    ['marketing', 'business'],
    '0 10 * * 1',
    {
      description: '每周一上午，复盘上周营销活动数据：曝光、转化、成本与投放建议。',
      instruction:
        '每周一 10:00，请根据我提供的上周营销活动数据（渠道、曝光、点击、线索、成本），输出投放复盘：各渠道转化率与获客成本、表现最好与最差的活动、预算调整建议与下周测试计划。',
      title: '营销活动周复盘',
    },
    {
      description:
        'Every Monday morning, review last week’s campaign data: reach, conversion, cost and spend recommendations.',
      instruction:
        'Every Monday at 10:00, using last week’s campaign data I provide (channel, impressions, clicks, leads, spend), write a performance review: conversion rate and cost per lead by channel, best and worst campaigns, budget reallocation advice and next week’s test plan.',
      title: 'Weekly campaign review',
    },
  ),
  entry(
    1403,
    'mkt-content-plan-weekly',
    'marketing',
    ['marketing', 'writing', 'creator'],
    '0 15 * * 5',
    {
      description: '每周五下午，结合产品节奏与行业热点，规划下周的内容发布计划与选题。',
      instruction:
        '每周五 15:00，请根据我提供的产品节奏、行业热点与目标受众，规划下周内容日历：每天一个选题（渠道、形式、核心信息、行动号召），并为其中 2 篇给出提纲。',
      title: '内容发布计划',
    },
    {
      description:
        'Every Friday afternoon, plan next week’s content calendar around product milestones and industry topics.',
      instruction:
        'Every Friday at 15:00, using the product schedule, industry topics and target audience I provide, plan next week’s content calendar: one topic per day (channel, format, key message, call to action) and outlines for 2 of them.',
      title: 'Weekly content plan',
    },
  ),
  // ───────────────────────────── 产品 / Product ─────────────────────────────
  entry(
    1501,
    'prod-user-feedback-digest',
    'product',
    ['product', 'sales'],
    '0 9 * * 1,3,5',
    {
      description: '每周一三五早晨，归纳最新用户反馈，聚类问题并按频次与影响排序。',
      instruction:
        '每周一、三、五 09:00，请根据我提供的用户反馈（工单、访谈、评论、销售转述），做聚类归纳：主题、出现频次、涉及用户类型、影响程度、代表性原话，并给出建议进入需求池的 3 项。',
      title: '用户反馈归纳',
    },
    {
      description:
        'Every Mon / Wed / Fri morning, cluster the latest user feedback and rank it by frequency and impact.',
      instruction:
        'Every Monday, Wednesday and Friday at 09:00, cluster the user feedback I provide (tickets, interviews, reviews, sales notes): theme, frequency, user segment, severity, representative quotes, and the 3 items that should enter the backlog.',
      title: 'User feedback digest',
    },
  ),
  entry(
    1502,
    'prod-sprint-planning-prep',
    'product',
    ['product', 'coding'],
    '0 14 * * 4',
    {
      description: '每周四下午，为下个迭代规划做准备：需求池排序、就绪度检查与容量建议。',
      instruction:
        '每周四 14:00，请根据我提供的需求池与团队容量，输出迭代规划准备材料：按价值 / 成本排序的候选需求、每项的就绪度（验收标准、设计、依赖是否齐备）、建议纳入的范围与风险提示。',
      title: '迭代规划准备',
    },
    {
      description:
        'Every Thursday afternoon, prepare sprint planning: backlog ranking, readiness check and capacity advice.',
      instruction:
        'Every Thursday at 14:00, using the backlog and team capacity I provide, prepare planning material: candidates ranked by value / cost, readiness of each (acceptance criteria, design, dependencies), recommended scope and risks.',
      title: 'Sprint planning prep',
    },
  ),
  entry(
    1503,
    'prod-metrics-weekly-readout',
    'product',
    ['product', 'business'],
    '0 9 * * 2',
    {
      description: '每周二早晨，解读核心产品指标变化，指出异常与可能原因。',
      instruction:
        '每周二 09:00，请根据我提供的核心指标（活跃、留存、转化、关键功能使用），输出指标周读：环比变化、显著异常及可能原因、值得深挖的细分维度、建议的下一步分析或实验。',
      title: '产品指标周读',
    },
    {
      description:
        'Every Tuesday morning, interpret movements in core product metrics and point out anomalies and likely causes.',
      instruction:
        'Every Tuesday at 09:00, using the core metrics I provide (active users, retention, conversion, key feature usage), write a weekly readout: week-over-week changes, notable anomalies with likely causes, segments worth drilling into, and the next analysis or experiment to run.',
      title: 'Weekly product metrics readout',
    },
  ),
  // ───────────────────────────── 人力 / HR ─────────────────────────────
  entry(
    1601,
    'hr-recruiting-pipeline-weekly',
    'hr',
    ['hr', 'business'],
    '0 10 * * 1',
    {
      description: '每周一上午，汇总各岗位招聘进展、卡点与本周面试安排。',
      instruction:
        '每周一 10:00，请根据我提供的招聘数据（岗位、各阶段候选人数、面试反馈、Offer 状态），输出招聘周报：各岗位漏斗、停滞环节与原因、本周面试安排、需要用人经理决策的事项。',
      title: '招聘进展周报',
    },
    {
      description:
        'Every Monday morning, summarise hiring progress per role, bottlenecks and this week’s interviews.',
      instruction:
        'Every Monday at 10:00, using the recruiting data I provide (role, candidates per stage, interview feedback, offer status), write a hiring report: funnel per role, stalled stages and why, this week’s interview schedule and decisions needed from hiring managers.',
      title: 'Weekly recruiting report',
    },
  ),
  entry(
    1602,
    'hr-onboarding-checklist',
    'hr',
    ['hr', 'operations'],
    '0 9 * * 1',
    {
      description: '每周一早晨，为本周入职的新员工生成入职清单与首周安排。',
      instruction:
        '每周一 09:00，请根据我提供的本周入职名单（姓名、岗位、部门、入职日期），为每人生成入职清单：账号与设备、制度培训、导师安排、首周目标与关键会议，并列出需要各部门提前准备的事项。',
      title: '新员工入职清单',
    },
    {
      description:
        'Every Monday morning, generate onboarding checklists and first-week plans for this week’s new hires.',
      instruction:
        'Every Monday at 09:00, using this week’s new-hire list I provide (name, role, department, start date), generate an onboarding checklist per person: accounts and equipment, policy training, buddy assignment, first-week goals and key meetings, plus what each department must prepare in advance.',
      title: 'New-hire onboarding checklist',
    },
  ),
  entry(
    1603,
    'hr-team-pulse-monthly',
    'hr',
    ['hr', 'business'],
    '0 10 * * 5',
    {
      description: '每周五上午，汇总近期员工反馈与离职风险信号，给出团队氛围与保留建议。',
      instruction:
        '每周五 10:00，请根据我提供的员工反馈、一对一记录与考勤 / 加班数据，归纳团队状态：普遍关注点、潜在离职风险信号、需要管理者跟进的个体，以及可落地的改善建议。注意匿名与保密表述。',
      title: '团队状态与保留建议',
    },
    {
      description:
        'Every Friday morning, summarise employee feedback and attrition signals into team-health and retention advice.',
      instruction:
        'Every Friday at 10:00, using the employee feedback, 1:1 notes and attendance / overtime data I provide, summarise team health: common concerns, potential attrition signals, individuals managers should follow up with, and actionable improvements. Keep wording anonymous and confidential.',
      title: 'Team health & retention notes',
    },
  ),
  // ───────────────────────────── 财务 / 法务 — Finance / Legal ─────────────────────────────
  entry(
    1701,
    'fin-cashflow-weekly',
    'finance-legal',
    ['finance-legal', 'business'],
    '0 9 * * 1',
    {
      description: '每周一早晨，审阅本周应收、应付与大额支出，提示现金流风险。',
      instruction:
        '每周一 09:00，请根据我提供的应收账款、应付账款与未来两周计划支出，输出现金流周报：本周预计流入与流出、逾期应收清单与催收建议、可能的资金缺口及应对方案。',
      title: '现金流周报',
    },
    {
      description:
        'Every Monday morning, review this week’s receivables, payables and large outflows and flag cash-flow risk.',
      instruction:
        'Every Monday at 09:00, using the receivables, payables and two-week planned spend I provide, write a cash-flow report: expected inflows and outflows this week, overdue receivables with collection suggestions, and any funding gap with options to close it.',
      title: 'Weekly cash-flow report',
    },
  ),
  entry(
    1702,
    'fin-expense-anomaly-check',
    'finance-legal',
    ['finance-legal', 'operations'],
    '0 15 * * 3',
    {
      description: '每周三下午，扫描费用报销与采购单据，标出异常金额、重复报销与超预算项目。',
      instruction:
        '每周三 15:00，请根据我提供的费用与采购明细，检查：超出标准或预算的项目、疑似重复报销、缺少必要凭证或审批的单据、同类费用异常增长，输出异常清单与建议处理方式。',
      title: '费用异常检查',
    },
    {
      description:
        'Every Wednesday afternoon, scan expense claims and purchase orders for anomalies, duplicates and budget overruns.',
      instruction:
        'Every Wednesday at 15:00, using the expense and purchase details I provide, check for items over policy or budget, suspected duplicate claims, missing receipts or approvals and unusual growth in a category; output an anomaly list with suggested handling.',
      title: 'Expense anomaly check',
    },
  ),
  entry(
    1703,
    'legal-contract-expiry-weekly',
    'finance-legal',
    ['finance-legal', 'business'],
    '0 10 * * 1',
    {
      description: '每周一上午，列出未来 60 天内到期的合同与续约窗口，提示关键条款。',
      instruction:
        '每周一 10:00，请根据我提供的合同台账（对方、类型、到期日、自动续约条款、通知期限），列出未来 60 天内到期或进入续约通知期的合同，注明关键条款、建议动作与负责人，并标出已错过通知期限的项目。',
      title: '合同到期提醒',
    },
    {
      description:
        'Every Monday morning, list contracts expiring or entering renewal windows in the next 60 days with key terms.',
      instruction:
        'Every Monday at 10:00, using the contract ledger I provide (counterparty, type, expiry, auto-renewal terms, notice period), list contracts expiring or entering their notice period within 60 days, with key terms, suggested action and owner, and flag any missed notice deadlines.',
      title: 'Contract expiry reminder',
    },
  ),
  entry(
    1704,
    'legal-compliance-update-weekly',
    'finance-legal',
    ['finance-legal', 'business'],
    '0 9 * * 3',
    {
      description: '每周三早晨，整理与本行业相关的法规政策变化，评估对业务的影响。',
      instruction:
        '每周三 09:00，请根据我提供的近期法规、政策或标准更新，整理合规动态：变更要点、生效时间、对我们业务与流程的影响、需要调整的制度或合同条款，以及建议的责任部门。',
      title: '合规动态周报',
    },
    {
      description:
        'Every Wednesday morning, summarise regulatory and policy changes relevant to our industry and assess business impact.',
      instruction:
        'Every Wednesday at 09:00, using the recent regulation, policy or standard updates I provide, write a compliance digest: key changes, effective dates, impact on our business and processes, policies or contract clauses that need updating, and the suggested owning department.',
      title: 'Weekly compliance digest',
    },
  ),
];

const LIBRARY_LOCALES: readonly TaskTemplateLibraryLocale[] = ['zh-CN', 'en-US'];

/** zh / zh-* → zh-CN, everything else → en-US. */
export const resolveTaskTemplateLibraryLocale = (locale?: string): TaskTemplateLibraryLocale =>
  locale && /^zh(?:[-_]|$)/i.test(locale.trim()) ? 'zh-CN' : 'en-US';

export const toLocalizedTaskTemplate = (
  item: TaskTemplateLibraryEntry,
  locale: TaskTemplateLibraryLocale,
): TaskTemplate => {
  const text = item.text[locale] ?? item.text['en-US'];
  return {
    category: item.category,
    connectors: item.connectors,
    cronPattern: item.cronPattern,
    description: text.description,
    id: item.id,
    identifier: item.identifier,
    instruction: text.instruction,
    interests: item.interests,
    title: text.title,
  };
};

/** The whole bundled library, localized. */
export const listTaskTemplateLibrary = (locale?: string): TaskTemplate[] => {
  const resolved = resolveTaskTemplateLibraryLocale(locale);
  return TASK_TEMPLATE_LIBRARY.map((item) => toLocalizedTaskTemplate(item, resolved));
};

export const TASK_TEMPLATE_LIBRARY_LOCALES = LIBRARY_LOCALES;
