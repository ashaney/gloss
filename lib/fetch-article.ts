/**
 * Reading a web page into an Article, on the server: the link import, and
 * anything an agent saves. Every redirect hop is checked against private,
 * loopback and link-local addresses before it is fetched, and every connection
 * checks the address it actually dials, so a name can't pass the first check
 * and then resolve somewhere private for the fetch.
 */

import dns from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { parseHTML } from "linkedom";
import { imageStem, leadImage, prepareImages } from "@/lib/images";
import { Readability } from "@mozilla/readability";
import { htmlToBlocks } from "@/lib/html-to-blocks";
import { slugify, tidyTitle, undash, type Article, type Block } from "@/lib/article";
import { APP_UA } from "@/lib/muse";

const MAX_BYTES = 6_000_000;
/** A manual or a report with pictures runs to tens of megabytes; the browser reads it, at most PDF_MAX_PAGES pages. */
const MAX_PDF_BYTES = 100_000_000;
/** How long a site has to answer, and then to send the rest (a big PDF from a slow host). */
const ANSWER_MS = 15_000;
const BODY_MS = 90_000;
/** Fewer words than this is a page whose article never reached the HTML. The shortest real one on a tested shelf had 220. */
const MIN_WORDS = 80;

/** Refuse anything that resolves to a private, loopback or link-local address. */
function isPrivate(ip: string): boolean {
  if (ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const p = v4.split(".").map(Number);
  if (p.length !== 4) return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

const PRIVATE = "That address is not reachable from here.";
const NO_SITE = "Could not find that site. Check the link.";

/** A resolver for each connection that refuses a private address, whatever an earlier lookup said. */
const publicOnly: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivate(a.address))) {
      return callback(Object.assign(new Error(PRIVATE), { code: "EPRIVATEADDR" }), "", 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/** Outside fetches go through this: the same fetch, but every socket resolves with publicOnly. */
const outside = new Agent({ connect: { lookup: publicOnly } });

/** Whether a failed fetch was the per-connection check refusing a private address. */
function refusedPrivate(e: unknown): boolean {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: string }).code === "EPRIVATEADDR") return true;
  }
  return false;
}

async function safeUrl(raw: string): Promise<URL | string> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return "That does not look like a link.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https links can be imported.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return PRIVATE;
  try {
    const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (ips.some(isPrivate)) return PRIVATE;
  } catch {
    return NO_SITE;
  }
  return url;
}

/** The body as it streams in, or null once it runs past `max` bytes, so an oversized file is dropped early. */
async function readCapped(res: Response, max: number): Promise<ArrayBuffer | null> {
  if (Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/** Readability's excerpt is often just the first paragraph; only keep it when it adds something. */
function dekFrom(excerpt: string | null | undefined, blocks: Block[]): string | undefined {
  const dek = undash((excerpt ?? "").trim());
  if (dek.length < 20) return undefined;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const first = norm(blocks.find((b) => b.type === "p")?.runs.map((r) => r.text).join("") ?? "");
  if (first.startsWith(norm(dek).slice(0, 60))) return undefined;
  return dek.length > 280 ? `${dek.slice(0, 277).replace(/\s+\S*$/, "")}...` : dek;
}

/**
 * React streaming (Next.js App Router, Suspense) sends a skeleton first:
 * `<!--$?--><template id="B:6"></template>...fallback...<!--/$-->`, and the real
 * content later in `<div hidden id="S:6">`, which a script ($RC) moves into
 * place. Readability drops hidden nodes, so the article went with it. This does
 * the script's work: the content replaces its placeholder and the fallback goes.
 * A segment for `<template id="P:9">` ($RS) replaces that template.
 */
function revealStreamed(doc: Document) {
  for (const seg of Array.from(doc.querySelectorAll("div[hidden]"))) {
    const m = /^S:(\d+)$/.exec(seg.id);
    if (!m) continue;
    const boundary = doc.getElementById(`B:${m[1]}`);
    const slot = boundary ?? doc.getElementById(`P:${m[1]}`);
    if (!slot?.parentNode) {
      seg.removeAttribute("hidden");
      continue;
    }
    if (boundary) {
      // The fallback runs from the template to the comment that closes its boundary.
      let depth = 0;
      for (let n = boundary.nextSibling; n; ) {
        const next = n.nextSibling;
        if (n.nodeType === 8) {
          const data = (n as Comment).data;
          if (data === "/$") {
            if (depth === 0) break;
            depth--;
          } else if (data === "$" || data === "$?" || data === "$!") depth++;
        }
        n.parentNode?.removeChild(n);
        n = next;
      }
    }
    while (seg.firstChild) slot.parentNode.insertBefore(seg.firstChild, slot);
    slot.parentNode.removeChild(slot);
    seg.parentNode?.removeChild(seg);
  }
}

const SOCIAL = /^(x\.com|twitter\.com|mobile\.twitter\.com|threads\.net|bsky\.app|instagram\.com|facebook\.com|linkedin\.com\/posts)/;
const VIDEO = /^(youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be|vimeo\.com|tiktok\.com)\//;

/** Links that are a post or a video rather than an article: their pages are script shells with nothing to read. */
export function notAnArticle(url: string): "social" | "video" | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    return null;
  }
  const at = `${u.hostname.replace(/^www\./, "")}${u.pathname}`;
  return SOCIAL.test(at) ? "social" : VIDEO.test(at) ? "video" : null;
}

/** arXiv ids: new style (2610.07469v2) and old style (cs/9605103, math.GT/0309136). */
const ARXIV = /^(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?$/;

/**
 * The full text of an arXiv paper, for a link to its abstract page: that page
 * holds only the abstract, so a reader that can take a PDF gets the PDF, and
 * one that can't (an agent) gets arXiv's HTML rendering of the paper.
 */
export function arxivFullText(url: string, as: "pdf" | "html"): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    return null;
  }
  const m = ARXIV.exec(`${u.hostname}${u.pathname}`);
  if (!m) return null;
  if (as === "pdf") return u.pathname.startsWith("/abs/") ? `https://arxiv.org/pdf/${m[1]}` : null;
  return `https://arxiv.org/html/${m[1]}`;
}

/**
 * Why a link could not be read, for a caller that acts on the reason rather than
 * showing it (aarOS turns a post or a video into a picture card, and leaves a PDF be).
 */
export type FailKind = "social" | "video" | "pdf" | "unreadable" | "blocked" | "not_found" | "error";

export type FetchResult =
  | { ok: true; article: Article }
  | { ok: true; pdf: ArrayBuffer; name: string }
  | { ok: false; error: string; status: number; kind: FailKind };

/** A link safeUrl turned down: a site that isn't there, or one Gloss won't fetch. */
const refused = (error: string): FetchResult => ({ ok: false, error, status: 400, kind: error === NO_SITE ? "not_found" : "error" });

/** `pdf`: the caller can read a PDF itself, so a PDF link comes back as the file instead of an error. */
export async function fetchArticle(raw: string, opts: { pdf?: boolean } = {}): Promise<FetchResult> {
  const checked = await safeUrl((opts.pdf && arxivFullText(raw, "pdf")) || raw.trim());
  if (typeof checked === "string") return refused(checked);
  const kind = notAnArticle(checked.toString());
  if (kind === "social") return { ok: false, error: "That's a post, not an article. Open the link it shares, or copy the post and use Paste text.", status: 422, kind };
  if (kind === "video") return { ok: false, error: "That's a video, and Gloss reads text. Copy its transcript and use Paste text.", status: 422, kind };

  // Follow redirects by hand so every hop gets the same private-address check.
  let res: Response | null = null;
  let target: URL = checked;
  // One abort for each hop: ANSWER_MS for the headers, then BODY_MS for the body of the last one.
  let hopAbort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let hop = 0; hop < 5; hop++) {
      hopAbort = new AbortController();
      const abort = hopAbort;
      timer = setTimeout(() => abort.abort(), ANSWER_MS);
      // Node's fetch takes an undici dispatcher; the DOM's RequestInit type doesn't name it.
      res = await fetch(target, {
        dispatcher: outside,
        redirect: "manual",
        signal: abort.signal,
        headers: {
          "User-Agent": `Mozilla/5.0 (compatible; ${APP_UA}; +reader)`,
          Accept: opts.pdf ? "text/html,application/xhtml+xml,application/pdf" : "text/html,application/xhtml+xml",
        },
      } as RequestInit);
      clearTimeout(timer);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      const next = await safeUrl(new URL(location, target).toString());
      if (typeof next === "string") return refused(next);
      target = next;
    }
  } catch (e) {
    clearTimeout(timer);
    if (refusedPrivate(e)) return refused(PRIVATE);
    return { ok: false, error: "The site did not answer in time.", status: 502, kind: "error" };
  }
  const abort = hopAbort;
  timer = setTimeout(() => abort.abort(), BODY_MS);
  try {
    return await readArticle(res, target, opts);
  } catch {
    return { ok: false, error: "The site stopped sending before the page arrived. Try again.", status: 502, kind: "error" };
  } finally {
    clearTimeout(timer);
    await res?.body?.cancel().catch(() => {});
  }
}

async function readArticle(res: Response | null, target: URL, opts: { pdf?: boolean }): Promise<FetchResult> {
  if (!res || !res.ok) {
    const status = res?.status ?? 0;
    const kind: FailKind = [401, 403, 429, 451].includes(status) ? "blocked" : status === 404 || status === 410 ? "not_found" : "error";
    const msg =
      kind === "blocked"
        ? "That site does not let readers like this one in. Copy the text and use Paste text instead."
        : kind === "not_found"
          ? "That page was not found. Check the link."
          : `The site answered ${status || "nothing"}. Try again, or paste the text instead.`;
    return { ok: false, error: msg, status: 502, kind };
  }

  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/pdf") && opts.pdf) {
    const pdf = await readCapped(res, MAX_PDF_BYTES);
    if (!pdf) return { ok: false, error: `That PDF is over ${MAX_PDF_BYTES / 1_000_000}MB, too large to import.`, status: 413, kind: "pdf" };
    const name = decodeURIComponent(target.pathname.split("/").pop() || "document.pdf");
    return { ok: true, pdf, name: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf` };
  }
  if (type.includes("application/pdf")) {
    return { ok: false, error: "That link is a PDF. Download it, then drop the file here.", status: 415, kind: "pdf" };
  }
  if (!type.includes("html")) return { ok: false, error: "That link is not a web page.", status: 415, kind: "unreadable" };

  const buf = await readCapped(res, MAX_BYTES);
  if (!buf) return { ok: false, error: "That page is too large to import.", status: 413, kind: "unreadable" };
  return articleFromHtml(new TextDecoder().decode(buf), target);
}

/** The largest page `articleFromHtml` takes from a caller, in characters. */
export const MAX_HTML_CHARS = MAX_BYTES;

/**
 * A page's HTML as an article, by the same reading a fetched page gets. `target` is where the
 * page lives: its links and pictures resolve against it, and it becomes the article's source.
 * Used directly when the page was read some other way (a real browser, an archived copy).
 */
export function articleFromHtml(html: string, target: URL): FetchResult {
  const { document } = parseHTML(html);
  // Readability resolves relative links against the document URL.
  try {
    const base = document.createElement("base");
    base.setAttribute("href", target.toString());
    document.head?.appendChild(base);
  } catch {}

  // Pages streamed by React arrive with their content hidden, to be swapped in by a script.
  try {
    revealStreamed(document as unknown as Document);
  } catch {}

  // Data tables (header cells or a caption) often carry classes like "sticky-header"
  // that Readability reads as page furniture and strips. Their classes go, so they stay.
  for (const t of Array.from(document.querySelectorAll("table"))) {
    const role = t.getAttribute("role");
    if (role === "presentation" || role === "navigation") continue;
    if (t.querySelector("th, thead, caption")) t.removeAttribute("class");
  }

  // Read before Readability, which rewrites the document it is given.
  let lead: string | null = null;
  try {
    lead = leadImage(document as unknown as Document, target.toString());
  } catch {}

  // Pictures resolved to one real URL each and rewrapped as plain figures, so Readability keeps them.
  try {
    prepareImages(document as unknown as Document, target.toString());
  } catch {
    // Pictures are a bonus; never lose the article over them.
  }

  let parsed: ReturnType<Readability["parse"]> = null;
  try {
    parsed = new Readability(document as unknown as Document, { charThreshold: 400 }).parse();
  } catch {
    // Some unusual markup trips Readability up; that reads the same as no article found.
  }
  if (!parsed?.content) {
    return { ok: false, error: "Could not find an article on that page. Try pasting the text instead.", status: 422, kind: "unreadable" };
  }

  const { document: clean } = parseHTML(`<!doctype html><html><body><div id="r">${parsed.content}</div></body></html>`);
  const root = clean.getElementById("r");
  if (!root) return { ok: false, error: "Could not read that article.", status: 422, kind: "unreadable" };
  let blocks = htmlToBlocks(root as never, target.toString());
  const title = tidyTitle(undash((parsed.title || target.hostname).trim()));
  if (blocks[0] && blocks[0].type !== "p" && blocks[0].runs.map((r) => r.text).join("").trim() === title) blocks = blocks.slice(1);
  // The lead picture goes first, unless the article already opens with a picture or shows this one.
  const leadStem = lead ? imageStem(lead) : null;
  const shownAlready = (src?: string) => {
    if (!src || !leadStem) return false;
    try {
      return decodeURIComponent(src).includes(leadStem);
    } catch {
      return src.includes(leadStem);
    }
  };
  if (lead && !blocks.slice(0, 4).some((b) => b.type === "figure") && !blocks.some((b) => b.type === "figure" && shownAlready(b.src))) {
    blocks = [{ id: "b0", type: "figure", runs: [], src: lead }, ...blocks];
  }
  // A page drawn by scripts (a Google Doc, an app shell) leaves only its newsletter box and footer.
  const words = blocks.reduce((n, b) => n + b.runs.map((r) => r.text).join("").split(/\s+/).filter(Boolean).length, 0);
  if (blocks.filter((b) => b.type === "p").length < 2 || words < MIN_WORDS) {
    return { ok: false, error: "That page has too little text to read here.", status: 422, kind: "unreadable" };
  }

  const article: Article = {
    id: `${slugify(title)}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    author: parsed.byline ? undash(parsed.byline.replace(/^by\s+/i, "").trim()).slice(0, 120) : undefined,
    published: parsed.publishedTime ? new Date(parsed.publishedTime).getFullYear().toString() : undefined,
    dek: dekFrom(parsed.excerpt, blocks),
    source: parsed.siteName ?? target.hostname.replace(/^www\./, ""),
    sourceUrl: target.toString(),
    blocks,
    origin: "url",
    image: lead ?? undefined,
    addedAt: Date.now(),
  };
  return { ok: true, article };
}
