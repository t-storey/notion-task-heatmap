#!/usr/bin/env node
// Queries the Notion Tasks Tracker for Done tasks and aggregates per-person
// daily completion counts into data.json (read by index.html).
//
// Env: NOTION_TOKEN (internal integration secret), TASKS_DB_ID (32-char hex).
// Fails loudly on auth/schema errors and never replaces a good data.json
// with a partial or broken one: the file is written only after the full,
// validated fetch succeeds, via tmp-file + atomic rename.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TASKS_DB_ID = process.env.TASKS_DB_ID;
const NOTION_VERSION = "2025-09-03";

// "A day" is defined in the cofounders' home timezone, not UTC.
const TIMEZONE = "America/Los_Angeles";
const WEEKS = 53;

const STATUS_PROP = "Status";
const DONE_VALUE = "Done";
const ASSIGNEE_PROP = "Assignee";
const DATE_PROP = "Completed";

// Notion user IDs are stable even if display names change; names are only a
// fallback so the map survives a workspace re-invite.
const USER_KEYS = ["tom", "ivan", "gabe"];
const USER_IDS = {
  "340d872b-594c-8141-accd-000261aec88d": "tom",
  "340d872b-594c-8150-abdd-0002e7d598e6": "ivan",
  "340d872b-594c-8128-aff3-00024379129d": "gabe",
};

const OUT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data.json");

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!NOTION_TOKEN) fail("NOTION_TOKEN is not set. Add it with: gh secret set NOTION_TOKEN");
if (!TASKS_DB_ID) fail("TASKS_DB_ID is not set. Add it with: gh secret set TASKS_DB_ID");

async function api(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      console.warn(`Notion returned ${res.status}; retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let hint = "";
      if (res.status === 401) {
        hint = " The token was rejected — check the NOTION_TOKEN secret against notion.so/profile/integrations.";
      } else if (res.status === 404) {
        hint =
          " Either TASKS_DB_ID is wrong, or the Tasks database is not connected to the integration" +
          " (open the database → ••• → Connections → add the integration).";
      }
      throw new Error(`Notion API ${method} ${path} failed with ${res.status}.${hint}\n${text}`);
    }
    return JSON.parse(text);
  }
}

// --- Resolve the database's data source and validate the schema -------------

const db = await api("GET", `/databases/${TASKS_DB_ID}`);
const dataSource = db.data_sources?.[0];
if (!dataSource) fail(`Database ${TASKS_DB_ID} has no data sources — is this a database ID?`);

const schema = await api("GET", `/data_sources/${dataSource.id}`);
const props = schema.properties ?? {};

const expected = [
  [STATUS_PROP, ["status", "select"]],
  [ASSIGNEE_PROP, ["people"]],
  [DATE_PROP, ["date"]],
];
for (const [name, types] of expected) {
  if (!props[name] || !types.includes(props[name].type)) {
    fail(
      `Property "${name}" (${types.join("/")}) not found in the Tasks database schema. ` +
        `Available properties: ${Object.keys(props).join(", ")}`
    );
  }
}
const statusType = props[STATUS_PROP].type;

// --- Fetch every Done task (paginated) --------------------------------------

const pages = [];
let cursor;
do {
  const res = await api("POST", `/data_sources/${dataSource.id}/query`, {
    filter: { property: STATUS_PROP, [statusType]: { equals: DONE_VALUE } },
    page_size: 100,
    ...(cursor ? { start_cursor: cursor } : {}),
  });
  pages.push(...res.results);
  cursor = res.has_more ? res.next_cursor : undefined;
} while (cursor);

console.log(`Fetched ${pages.length} tasks with ${STATUS_PROP} = ${DONE_VALUE}.`);

// --- Aggregate counts per ISO day per person --------------------------------

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const toDay = (date) => dayFmt.format(date);

const todayISO = toDay(new Date());
const [y, m, d] = todayISO.split("-").map(Number);
const todayUTC = new Date(Date.UTC(y, m - 1, d));
const mondayOffset = (todayUTC.getUTCDay() + 6) % 7;
const startISO = new Date(todayUTC.getTime() - (mondayOffset + (WEEKS - 1) * 7) * 86400000)
  .toISOString()
  .slice(0, 10);

const pageTitle = (page) => {
  const title = Object.values(page.properties ?? {}).find((p) => p.type === "title");
  return title?.title?.map((t) => t.plain_text).join("") || page.id;
};
const byName = (name) => {
  const first = name?.trim().toLowerCase().split(/\s+/)[0];
  return USER_KEYS.includes(first) ? first : undefined;
};

const counts = Object.fromEntries(USER_KEYS.map((k) => [k, {}]));
const fallbackTasks = [];
const unmatched = new Set();

for (const page of pages) {
  const keys = new Set();
  for (const person of page.properties?.[ASSIGNEE_PROP]?.people ?? []) {
    const key = USER_IDS[person.id] ?? byName(person.name);
    if (key) keys.add(key);
    else unmatched.add(person.name || person.id);
  }
  if (keys.size === 0) continue;

  const rawDate = page.properties?.[DATE_PROP]?.date?.start;
  let day;
  if (rawDate) {
    day = rawDate.includes("T") ? toDay(new Date(rawDate)) : rawDate;
  } else {
    day = toDay(new Date(page.last_edited_time));
    fallbackTasks.push(pageTitle(page));
  }
  if (day < startISO || day > todayISO) continue;

  for (const key of keys) counts[key][day] = (counts[key][day] ?? 0) + 1;
}

if (fallbackTasks.length) {
  console.warn(
    `⚠ ${fallbackTasks.length} Done task(s) have no "${DATE_PROP}" date; ` +
      `bucketed by last_edited_time instead (check the Notion automation): ` +
      fallbackTasks.slice(0, 10).join(" | ")
  );
}
if (unmatched.size) {
  console.warn(`⚠ Assignees not mapped to a view: ${[...unmatched].join(", ")}`);
}

// --- Write data.json only when the counts actually changed ------------------

const users = {};
for (const key of USER_KEYS) {
  users[key] = Object.fromEntries(
    Object.entries(counts[key]).sort(([a], [b]) => a.localeCompare(b))
  );
  const total = Object.values(users[key]).reduce((a, b) => a + b, 0);
  console.log(`${key}: ${total} completed task(s) across ${Object.keys(users[key]).length} day(s)`);
}

let previous = null;
try {
  previous = JSON.parse(readFileSync(OUT_FILE, "utf8"));
} catch {
  // No existing data.json (first run) or unreadable — write a fresh one.
}
if (previous && JSON.stringify(previous.users) === JSON.stringify(users)) {
  console.log("No changes since last run; leaving data.json untouched.");
  process.exit(0);
}

const tmp = `${OUT_FILE}.tmp`;
writeFileSync(tmp, JSON.stringify({ generatedAt: new Date().toISOString(), users }, null, 2) + "\n");
renameSync(tmp, OUT_FILE);
console.log(`Wrote ${OUT_FILE}`);
