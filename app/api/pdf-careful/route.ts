import { createHash } from "node:crypto";
import { parseCarefully, type Tier } from "@/lib/llamaparse";
import { clientId } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * "Read it more carefully": a PDF read again by LlamaParse, for layouts the
 * local reader gets wrong. It runs on the server's LlamaParse key, with a
 * daily page cap per client, tallied in memory: this fork runs as one
 * long-lived instance, so there is no database table for it anymore.
 */
// Agentic scored 8.1/10 against cost_effective's 6.9 in scripts/pdf-eval, at $0.0125 a page against $0.0037.
const TIER: Tier = "agentic";
/** Vercel refuses request bodies over 4.5MB. */
const MAX_BYTES = 4_300_000;
const MAX_PAGES = 60;
const PAGES_PER_DAY = 200;

const hash = (s: string) => createHash("sha256").update(`gloss:${s}`).digest("hex").slice(0, 32);

/** Pages read carefully per client per day, in this instance only. */
const dailyPages = new Map<string, { day: string; pages: number }>();
const todayKey = () => new Date().toISOString().slice(0, 10);

function pagesToday(subject: string): number {
  const rec = dailyPages.get(subject);
  return rec && rec.day === todayKey() ? rec.pages : 0;
}

function record(subject: string, pages: number) {
  const day = todayKey();
  const rec = dailyPages.get(subject);
  dailyPages.set(subject, { day, pages: (rec && rec.day === day ? rec.pages : 0) + pages });
  if (dailyPages.size > 10_000) for (const [k, v] of dailyPages) if (v.day !== day) dailyPages.delete(k);
}

export async function POST(req: Request) {
  if (!process.env.LLAMA_CLOUD_API_KEY) {
    return Response.json({ error: "Careful reading is not set up on this server." }, { status: 500 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 10_000) return tooLarge();

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {}
  if (!file) return Response.json({ error: "Send the PDF as a file." }, { status: 400 });
  if (file.size > MAX_BYTES) return tooLarge();

  const subject = `careful:${hash(clientId(req))}`;
  const used = pagesToday(subject);
  if (used >= PAGES_PER_DAY) return Response.json({ error: `You've read ${PAGES_PER_DAY} pages carefully today. More tomorrow.` }, { status: 429 });

  const result = await parseCarefully(file, { tier: TIER, maxPages: Math.min(MAX_PAGES, PAGES_PER_DAY - used), signal: req.signal, deadlineMs: 270_000 });
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });
  record(subject, result.pages.length);
  return Response.json({ pages: result.pages, truncated: result.pages.length >= MAX_PAGES });
}

function tooLarge() {
  return Response.json({ error: "That PDF is over 4MB, too large to read carefully here." }, { status: 413 });
}
