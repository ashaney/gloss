/**
 * What the reader marked over a stretch of time, for aarOS on the same machine:
 * highlights, glosses, and texts read, finished or saved. Read-only. The hub's
 * nightly run writes it into the journal, and its desk shows today's review.
 * Server-side only.
 */

import { tidyTitle } from "./article";
import { query } from "./db";
import { todaysReview } from "./review";
import { sampleById } from "./samples";
import type { Gloss, Highlight, LibraryItem, Progress } from "./store";

const LIMIT = 500;
const ANSWER_CHARS = 600;

/** The reader's day, for the review. aarOS counts days in the same zone. */
export const READER_TZ = process.env.READER_TZ || "America/Chicago";

export type MarkArticle = { id: string; title: string; author?: string; source?: string; url?: string; words: number; addedAt?: number; finishedAt?: number };
export type MarkHighlight = { id: string; articleId: string; quote: string; note?: string; color?: string; createdAt: number };
export type MarkGloss = { id: string; articleId: string; quote?: string; action: string; question?: string; answer?: string; createdAt: number };
export type MarkRead = { articleId: string; pct: number; at: number; finished: boolean };
export type Marks = { from: number; to: number; articles: MarkArticle[]; highlights: MarkHighlight[]; glosses: MarkGloss[]; read: MarkRead[]; added: string[] };

export type ReviewItem = MarkHighlight & { title: string; author?: string };
export type Review = { done: number; deck: ReviewItem[] };

/** A millisecond field of the row's data, or null when it isn't a number. Field names are constants. */
const ms = (field: string, table = "") => {
  const d = table ? `${table}.data` : "data";
  return `(case when jsonb_typeof(${d}->'${field}') = 'number' then (${d}->>'${field}')::double precision end)`;
};

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

async function inWindow(table: string, field: string, userId: string, from: number, to: number) {
  return query(
    `select id, article_id, data from ${table}
     where user_id = $1 and not deleted and ${ms(field)} > $2 and ${ms(field)} <= $3
     order by ${ms(field)} limit ${LIMIT}`,
    [userId, from, to]
  );
}

function toHighlight(row: Record<string, unknown>): MarkHighlight | null {
  const h = row.data as Partial<Highlight>;
  const quote = text(h.anchor?.quote);
  const createdAt = num(h.createdAt);
  if (!quote || createdAt === undefined) return null;
  return { id: String(row.id), articleId: String(row.article_id), quote, note: text(h.note), color: text(h.color), createdAt };
}

function toGloss(row: Record<string, unknown>): MarkGloss | null {
  const g = row.data as Partial<Gloss>;
  const createdAt = num(g.createdAt);
  if (createdAt === undefined) return null;
  const turns = Array.isArray(g.turns) ? g.turns : [];
  const asked = turns.find((t) => t.role === "user");
  const answered = turns.find((t) => t.role === "assistant" && !t.error && !t.streaming && text(t.content));
  return {
    id: String(row.id),
    articleId: String(row.article_id),
    quote: text(g.anchor?.quote),
    action: text(g.action) ?? "ask",
    question: text(g.question) ?? text(asked?.content),
    answer: answered ? cut(answered.content.trim(), ANSWER_CHARS) : undefined,
    createdAt,
  };
}

function toArticle(id: string, data: Partial<LibraryItem> | undefined): MarkArticle {
  const sample = data ? null : sampleById(id);
  return {
    id,
    title: tidyTitle(text(data?.title) ?? text(sample?.title) ?? "Untitled"),
    author: text(data?.author) ?? text(sample?.author),
    source: text(data?.source),
    url: text(data?.sourceUrl),
    words: num(data?.words) ?? 0,
    addedAt: num(data?.addedAt),
    finishedAt: num(data?.finishedAt),
  };
}

/** Everything marked in (from, to], epoch milliseconds. */
export async function marksBetween(userId: string, from: number, to: number): Promise<Marks> {
  const [hRows, gRows, pRows, added, finished] = await Promise.all([
    inWindow("highlights", "createdAt", userId, from, to),
    inWindow("glosses", "createdAt", userId, from, to),
    inWindow("progress", "at", userId, from, to),
    inWindow("articles", "addedAt", userId, from, to),
    inWindow("articles", "finishedAt", userId, from, to),
  ]);

  const highlights = hRows.map(toHighlight).filter((h): h is MarkHighlight => h !== null);
  const glosses = gRows.map(toGloss).filter((g): g is MarkGloss => g !== null);

  const read = new Map<string, MarkRead>();
  for (const r of pRows) {
    const p = r.data as Partial<Progress>;
    const pct = Math.round(Math.min(1, Math.max(0, num(p.pct) ?? 0)) * 100);
    read.set(String(r.article_id), { articleId: String(r.article_id), pct, at: num(p.at) ?? to, finished: pct >= 100 });
  }
  for (const r of finished) {
    const id = String(r.id);
    const at = num((r.data as Partial<LibraryItem>).finishedAt) ?? to;
    read.set(id, { articleId: id, pct: 100, at: Math.max(at, read.get(id)?.at ?? 0), finished: true });
  }

  const ids = new Set<string>([...highlights.map((h) => h.articleId), ...glosses.map((g) => g.articleId), ...read.keys(), ...added.map((r) => String(r.id))]);
  const known = ids.size
    ? await query("select id, data from articles where user_id = $1 and not deleted and id = any($2::text[])", [userId, [...ids]])
    : [];
  const byId = new Map(known.map((r) => [String(r.id), r.data as Partial<LibraryItem>]));

  return {
    from,
    to,
    articles: [...ids].map((id) => toArticle(id, byId.get(id))),
    highlights,
    glosses,
    read: [...read.values()].sort((a, b) => a.at - b.at),
    added: added.map((r) => String(r.id)),
  };
}

/** Midnight at the start of `t`'s day in `tz`, as epoch milliseconds. */
export function startOfDayIn(tz: string, t: number): number {
  const parts = (at: number) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    const o = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, Number(p.value)]));
    return o as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  };
  const offset = (at: number) => {
    const p = parts(at);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  const p = parts(t);
  const midnight = Date.UTC(p.year, p.month - 1, p.day);
  return midnight - offset(midnight - offset(midnight));
}

/** Today's highlights due for review, as the landing's daily highlight picks them. */
export async function reviewToday(userId: string, now = Date.now(), tz = READER_TZ): Promise<Review> {
  const rows = await query(
    `select h.id, h.article_id, h.data, a.data as article, (a.id is not null) as shelved from highlights h
     left join articles a on a.user_id = h.user_id and a.id = h.article_id and not a.deleted
     where h.user_id = $1 and not h.deleted`,
    [userId]
  );
  const titles = new Map<string, { title: string; author?: string }>();
  const all: Highlight[] = [];
  for (const r of rows) {
    const id = String(r.article_id);
    // Like the landing: only highlights on a text still on the shelf, or a bundled sample.
    if (!r.shelved && !sampleById(id)) continue;
    const h = r.data as Highlight;
    if (!text(h?.anchor?.quote) || num(h.createdAt) === undefined) continue;
    all.push({ ...h, id: String(r.id), articleId: id });
    if (!titles.has(id)) {
      const a = toArticle(id, r.shelved ? (r.article as Partial<LibraryItem>) : undefined);
      titles.set(id, { title: a.title, author: a.author });
    }
  }
  const { deck, done } = todaysReview(all, now, startOfDayIn(tz, now));
  return {
    done,
    deck: deck.map((h) => ({
      id: h.id,
      articleId: h.articleId,
      quote: h.anchor.quote.trim(),
      note: text(h.note),
      color: text(h.color),
      createdAt: h.createdAt,
      ...titles.get(h.articleId)!,
    })),
  };
}
