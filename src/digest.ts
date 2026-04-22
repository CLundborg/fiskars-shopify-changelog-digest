import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { XMLParser } from "fast-xml-parser";

interface RawRssItem {
  guid?: string | { "#text"?: string };
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  category?: string | string[];
}

interface Entry {
  id: string;
  title: string;
  link: string;
  publishedAt: string; // ISO
  tags: string[];
  excerpt: string;
  actionRequired: boolean;
}

interface State {
  lastRunAt: string;
  seenIds: string[];
}

const FEED_URL = "https://shopify.dev/changelog/feed.xml";
const STATE_PATH = resolve("state", "seen.json");
const MAX_SEEN = 500; // keep the state file bounded
// Slack caps Block Kit messages at 50 blocks. We use 3 for header/context/divider
// and a potential 1 for an overflow footer, so keep ≤46 entries per message.
const MAX_ENTRIES_PER_MESSAGE = 40;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const markSeenOnly = process.argv.includes("--mark-seen-only");
  const webhook = process.env["SLACK_WEBHOOK_URL"];

  if (!dryRun && !markSeenOnly && !webhook) {
    console.error(
      "SLACK_WEBHOOK_URL is required (or pass --dry-run / --mark-seen-only)",
    );
    process.exit(2);
  }

  console.log(`[digest] fetching ${FEED_URL}`);
  const entries = await fetchFeed(FEED_URL);
  console.log(`[digest] parsed ${entries.length} entries from feed`);

  const state = await loadState();
  const seen = new Set(state.seenIds);
  const newEntries = entries.filter((e) => !seen.has(e.id));

  // Sort newest first
  newEntries.sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );

  console.log(`[digest] ${newEntries.length} new entries since last run`);

  if (markSeenOnly) {
    console.log(
      `[digest] --mark-seen-only: recording ${entries.length} entries as seen without posting.`,
    );
    await persistState(entries, state);
    return;
  }

  const payload =
    newEntries.length > 0
      ? buildDigestMessage(newEntries)
      : buildEmptyMessage();

  if (dryRun) {
    console.log("[digest] --dry-run, not posting. Payload:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[digest] posting to Slack…`);
  await postToSlack(webhook!, payload);
  console.log(`[digest] posted.`);

  await persistState(entries, state);
}

async function persistState(entries: Entry[], previous: State): Promise<void> {
  // Keep the most recent MAX_SEEN ids so the file doesn't grow forever, but
  // union with previously-seen so a feed trim can't cause us to re-announce
  // older entries.
  const allIds = entries
    .slice()
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_SEEN)
    .map((e) => e.id);
  const merged = Array.from(new Set([...allIds, ...previous.seenIds])).slice(
    0,
    MAX_SEEN,
  );
  await saveState({
    lastRunAt: new Date().toISOString(),
    seenIds: merged,
  });
  console.log(`[digest] state saved (${merged.length} ids tracked).`);
}

async function fetchFeed(url: string): Promise<Entry[]> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "fiskars-shopify-changelog-digest/0.1",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch feed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    textNodeName: "#text",
  });
  const parsed = parser.parse(xml);
  const itemsRaw = parsed?.rss?.channel?.item;
  const items: RawRssItem[] = Array.isArray(itemsRaw)
    ? itemsRaw
    : itemsRaw
      ? [itemsRaw]
      : [];
  return items.map(normalise).filter((e): e is Entry => e !== null);
}

function normalise(raw: RawRssItem): Entry | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const link = typeof raw.link === "string" ? raw.link.trim() : "";
  if (!title || !link) return null;

  const guidRaw = raw.guid;
  const guid =
    typeof guidRaw === "string"
      ? guidRaw
      : typeof guidRaw === "object" && guidRaw && "#text" in guidRaw
        ? String(guidRaw["#text"])
        : "";
  const id = guid || link;

  const pub = typeof raw.pubDate === "string" ? raw.pubDate : "";
  let isoDate = new Date().toISOString();
  if (pub) {
    const parsed = Date.parse(pub);
    if (!Number.isNaN(parsed)) isoDate = new Date(parsed).toISOString();
  }

  const tags: string[] = Array.isArray(raw.category)
    ? raw.category.map(String).filter(Boolean)
    : typeof raw.category === "string"
      ? [raw.category]
      : [];
  const tagsLc = tags.map((t) => t.toLowerCase());
  const actionRequired = tagsLc.some((t) => t.includes("action required"));

  const descRaw = typeof raw.description === "string" ? raw.description : "";
  const excerpt = stripHtml(descRaw).trim().slice(0, 280);

  return {
    id,
    title,
    link,
    publishedAt: isoDate,
    tags,
    excerpt,
    actionRequired,
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

function buildDigestMessage(entries: Entry[]): unknown {
  const today = fmtHumanDate(new Date());
  const count = entries.length;
  const actionCount = entries.filter((e) => e.actionRequired).length;

  const shown = entries.slice(0, MAX_ENTRIES_PER_MESSAGE);
  const overflow = count - shown.length;

  const headerText =
    `📰 Shopify Changelog — ${count} new ` +
    (count === 1 ? "entry" : "entries") +
    (actionCount > 0 ? `  ·  ⚠️ ${actionCount} action required` : "");

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `*${today}*  ·  <${FEED_URL}|feed>` }],
    },
    { type: "divider" },
  ];

  for (const e of shown) {
    const date = fmtShortDate(new Date(e.publishedAt));
    const severity = e.actionRequired ? "🔴" : pickTagIcon(e.tags);
    const tagBadges = e.tags
      .slice(0, 4)
      .map((t) => `\`${escapeMd(t)}\``)
      .join(" ");
    const textLines = [
      `${severity} *<${e.link}|${escapeMd(e.title)}>*`,
      `${date}${tagBadges ? " · " + tagBadges : ""}`,
    ];
    if (e.excerpt) {
      textLines.push(`> ${truncate(escapeMd(e.excerpt), 260)}`);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: textLines.join("\n") },
    });
  }

  if (overflow > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `…and *${overflow}* more. See the full <https://shopify.dev/changelog|changelog>.`,
        },
      ],
    });
  }

  return {
    text: headerText, // fallback for notifications
    blocks,
  };
}

function buildEmptyMessage(): unknown {
  const today = fmtHumanDate(new Date());
  return {
    text: `✅ Shopify Changelog · Nothing new today · ${today}`,
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `✅ *Shopify Changelog*  ·  Nothing new today  ·  ${today}  ·  <${FEED_URL}|feed>`,
          },
        ],
      },
    ],
  };
}

function pickTagIcon(tags: string[]): string {
  const lc = tags.map((t) => t.toLowerCase());
  if (lc.some((t) => t.includes("deprecation") || t.includes("breaking")))
    return "🟠";
  if (lc.some((t) => t.includes("new") || t.includes("feature"))) return "🟢";
  return "🔵";
}

function escapeMd(s: string): string {
  // Slack mrkdwn: escape only the trio of characters that break links
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtHumanDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

function fmtShortDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Copenhagen",
  });
}

async function loadState(): Promise<State> {
  if (!existsSync(STATE_PATH)) {
    return { lastRunAt: "", seenIds: [] };
  }
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as State;
    return {
      lastRunAt: parsed.lastRunAt ?? "",
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
    };
  } catch (err) {
    console.warn(`[digest] could not parse state file: ${String(err)}`);
    return { lastRunAt: "", seenIds: [] };
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function postToSlack(webhook: string, payload: unknown): Promise<void> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Slack webhook failed: ${res.status} ${res.statusText} — ${body}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
