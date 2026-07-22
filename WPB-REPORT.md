# WPB Report — Admin Overview Dashboard

**Branch:** `feat/admin-overview-dashboard`\
**Worktree:** `/Users/konata/code/AIHub-worktrees/wpb`

| Commit     | Summary                                                               |
| ---------- | --------------------------------------------------------------------- |
| `b209b6c5` | ✨ Initial overview dashboard                                         |
| rework     | 🐛 Fix react-router import, lazy OverviewPage, dead code/i18n cleanup |

## Layout structure

Top → bottom on `/admin` (OverviewPage → OverviewDashboard):

1. **KPI row** (`KpiRow`) — five tiles in a responsive auto-fit grid
   - Total users · Active users (30d) · Messages · Topics · Agents
   - Scope footnote under the row (certainty of window)
2. **Main grid** (2 columns ≥960px, 1 column on narrow)
   - **Usage trend** (`UsageTrendCard`) — current-month daily token area chart
   - **Activity heatmap** (`HeatmapCard`) — messages / tokens heatmaps with type switch
3. **Rank cards** (`RankCards`) — 2 columns: Top models · Top agents (`BarList`, value on the right)
4. **Quick links** (`QuickLinks`) — card links to `/admin/stats`, `/admin/users`, `/admin/ai/providers`

Loading uses `Skeleton`; empty series show meaningful empty copy (not blank charts).

## Reused user-side components / patterns

| Piece                                              | Reuse                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AiHeatmaps`                                       | Full component via `StatsDataSourceProvider` + `adminGlobalStatsDataSource` (W10 parity injection; no fork) |
| `BarList` (`@lobehub/charts`)                      | Same ranking presentation as `ModelsRank` / `AssistantsRank`                                                |
| `ModelIcon` / `Avatar`                             | Same icon pattern as user rankings                                                                          |
| Scoped SWR keys                                    | `['admin-stats:…', ADMIN_GLOBAL_STATS_SCOPE, …]` aligned with `GlobalStatsPage`                             |
| `adminStatsService` / `adminGlobalStatsDataSource` | Existing client boundary; no new tRPC procedures                                                            |
| `formatIntergerNumber` / `formatTokenNumber`       | Shared format utils                                                                                         |
| `createStaticStyles` + `cssVar.*`                  | Zero-runtime styling                                                                                        |

**Not reused as-is:** personal `TotalMessages` / `UsageTrends` chrome (prev-month % and spend tabs are user-stats specific). Overview builds a 30-day KPI window and a token-only monthly trend instead.

**Unchanged:** `GlobalStatsPage` (`/admin/stats`) remains the full statistics surface.

## Data 口径 (metrics contract)

| Metric                     | Source                                                           | Window                            |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| Total users                | `admin.stats.totals({ activeDays: 30 }).usersTotal`              | All-time                          |
| Active users               | `totals.usersActive`                                             | Last **30** days (`lastActiveAt`) |
| Messages / Topics / Agents | `countMessages` / `countTopics` / `countAgents` with `startDate` | Last **30** days                  |
| Token usage trend          | `usageFindAndGroupByDay(mo = YYYY-MM)` → `totalTokens` per day   | Current calendar month            |
| Heatmap                    | `getHeatmaps` / `getTokenHeatmaps` (via `AiHeatmaps` tabs)       | Last year (component default)     |
| Top models                 | `rankModels()` (server default limit, UI shows top 5)            | All-time messages by model        |
| Top agents                 | `rankAgents(5)`                                                  | All-time topics by agent          |

Constant: `OVERVIEW_WINDOW_DAYS = 30` in `overview/constants.ts`.

## File organization

```text
src/enterprise/client/features/admin/overview/
  constants.ts
  utils.ts / utils.test.ts
  styles.ts
  useOverviewStats.ts
  KpiRow.tsx
  UsageTrendCard.tsx
  HeatmapCard.tsx
  RankCards.tsx
  QuickLinks.tsx
  OverviewDashboard.tsx
  index.ts                    # only re-exports OverviewDashboard
src/enterprise/client/features/admin/pages/OverviewPage.tsx  # assembly only
src/enterprise/client/routes/admin/createAdminRouteTree.tsx  # lazy OverviewPage
```

i18n: `packages/locales/src/default/admin.ts` (`overview.*`), mirrored `locales/en-US/admin.json`, hand-translated `locales/zh-CN/admin.json`.

## Engineering constraints (verified)

- No SPA route path/structure changes (only OverviewPage load strategy → `lazy`)
- No server / tRPC procedure changes
- No new dependencies
- No push

## Rework items (independent review → fixed)

| #   | Severity  | Fix                                                                                                                                                                                                                                                                                                |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Fatal** | `QuickLinks.tsx`: `react-router-dom` → `react-router` (package is `react-router@^8`, no `react-router-dom`)                                                                                                                                                                                        |
| 2   | **Perf**  | `createAdminRouteTree.tsx`: `OverviewPage` static import → `lazy()` + `withLazy`, matching other admin leaves so `@lobehub/charts` / heatmap stack stay out of the main SPA bundle. Confirmed no other static chain: only `OverviewPage` imports `overview/`; route tree uses lazy dynamic import. |
| 3   | Cleanup   | Removed dead keys `overview.heatmap.title`, `overview.placeholderNote` from default + en-US + zh-CN                                                                                                                                                                                                |
| 4   | Cleanup   | Removed unused `isEmptyHeatmap` (+ tests); trimmed `overview/index.ts` to `OverviewDashboard` only                                                                                                                                                                                                 |
| 5   | Cleanup   | `UsageTrendCard`: series category uses `t('overview.usageTrend.series')` (en: Tokens / zh: Token), not bare `"tokens"`                                                                                                                                                                             |

## Tests / quality gate

```bash
bun run check <rework files…>
# ✓ lint clean · tests 9 passed

bun run check --type
# only pre-existing SettingModal.tsx:77 on main; zero errors under overview/ or createAdminRouteTree
```

`utils.test.ts` covers:

- `overviewWindowStartDate` / `currentMonthKey`
- `toDailyTokenTrend` mapping
- `isEmptyTokenTrend` / `isEmptyRank`
