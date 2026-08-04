# notion-task-heatmap

GitHub-contribution-graph-style heatmap of completed tasks per day, one
switchable view per cofounder (Tom / Ivan / Gabe), fed by the Clinchr Notion
**Tasks Tracker** database and served as a static site on GitHub Pages —
built to be embedded in Notion.

**Live:** https://t-storey.github.io/notion-task-heatmap/

## How it works

```
Notion Tasks Tracker ──(hourly GitHub Action: scripts/fetch.mjs)──▶ data.json ──▶ index.html
```

- The Notion API can't be called from the browser (CORS + token exposure), so
  [update-data.yml](.github/workflows/update-data.yml) runs
  [scripts/fetch.mjs](scripts/fetch.mjs) hourly (plus on `workflow_dispatch`
  and pushes to `main`), queries tasks with **Status = Done**, buckets them
  per person per day, and commits `data.json` only when the counts changed.
- [index.html](index.html) is a single file (no framework, no build step)
  that fetches `./data.json` same-origin and renders 53 weeks × Mon–Sun with
  per-person quartile color thresholds, in Notion-native light/dark styling.

## Data semantics

- **Done** = Notion status property `Status` equals `Done`.
- **Day bucketing** uses the `Completed` date property, in
  `America/Los_Angeles`. A Notion automation should set it: Tasks Tracker →
  ⚡ → New automation → When `Status` → `Done` → Edit property `Completed` →
  date when triggered.
- Done tasks **missing** `Completed` fall back to `last_edited_time`
  (approximate) — the workflow logs a warning listing them.
- A task assigned to multiple people counts once for **each** of them.
- Assignees are matched by Notion **user ID** (display-name fallback); the
  map lives at the top of `scripts/fetch.mjs`.

## Setup

1. Create an internal integration at
   [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
   in the Clinchr workspace (read content capability is enough).
2. **Connect the Tasks Tracker database to it** — open the database → `•••` →
   Connections → your integration. Without this every query 404s.
3. Set the repo secrets (from a regular terminal):

   ```bash
   gh secret set NOTION_TOKEN --repo t-storey/notion-task-heatmap
   gh secret set TASKS_DB_ID --repo t-storey/notion-task-heatmap --body 3a6dd8692f2f801fb543ce74498b1f09
   ```

4. Enable GitHub Pages (deploy from branch `main`, root):

   ```bash
   gh api -X POST repos/t-storey/notion-task-heatmap/pages -f "source[branch]=main" -f "source[path]=/"
   ```

5. Trigger the first data refresh:

   ```bash
   gh workflow run update-data.yml --repo t-storey/notion-task-heatmap
   ```

## Embedding in Notion

Type `/embed`, paste one of these URLs, drag to resize:

- All three tabs: `https://t-storey.github.io/notion-task-heatmap/`
- Pre-filtered per person (e.g. three embeds under toggles or in columns):
  - `https://t-storey.github.io/notion-task-heatmap/?user=tom`
  - `https://t-storey.github.io/notion-task-heatmap/?user=ivan`
  - `https://t-storey.github.io/notion-task-heatmap/?user=gabe`

## Troubleshooting

- **Workflow fails with 404** — the Tasks database isn't connected to the
  integration (step 2 above), or `TASKS_DB_ID` is wrong.
- **Workflow fails with 401** — `NOTION_TOKEN` is wrong or was rotated.
- **"Property not found" error** — a property was renamed in Notion; update
  the constants at the top of `scripts/fetch.mjs`.
- **A cofounder's tab is empty** — their tasks aren't assigned to them via
  the `Assignee` property, or nothing is marked `Done` yet.
- **"updated N min ago" looks stale** — it reflects when the *counts last
  changed*, not the last poll; unchanged hourly runs don't rewrite data.json.
