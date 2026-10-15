"use client";

/**
 * "Read it more carefully": the PDF behind a text, read again by LlamaParse
 * through /api/pdf-careful, for layouts the local reader gets wrong (columns,
 * tables, maths, scans). Runs on the server's LlamaParse key.
 */

import { markdownBlocks, wordCount, type Article } from "./article";
import { htmlTablesToMarkdown, stitchBlocks } from "./pdf";
import { loadDoc, loadPdf, useStore } from "./store";

export type CarefulResult = { ok: true; article: Article } | { ok: false; error: string };

const same = (a: string, b: string) => a.replace(/\W+/g, "").toLowerCase() === b.replace(/\W+/g, "").toLowerCase();

export async function readCarefully(shown: Article, signal?: AbortSignal): Promise<CarefulResult> {
  // The reader shows a display copy; the new reading builds on the stored original.
  const article = (await loadDoc(shown.id)) ?? shown;
  const pdf = await loadPdf(article.id);
  if (!pdf) return { ok: false, error: "The PDF is not on this device. Open it again from the file to read it carefully." };

  const form = new FormData();
  form.append("file", pdf, "document.pdf");
  let j: { pages?: string[]; truncated?: boolean; error?: string };
  let status = 0;
  try {
    const res = await fetch("/api/pdf-careful", { method: "POST", body: form, signal });
    status = res.status;
    j = await res.json();
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: "Stopped." };
    return { ok: false, error: `Connection lost: ${String(e)}` };
  }
  if (status !== 200 || !j.pages) return { ok: false, error: j.error ?? `Request failed (${status}).` };
  // A partial reading would drop the rest of the text, so it does not replace anything.
  if (j.truncated) return { ok: false, error: "This PDF is too long to read carefully in one go (over 60 pages)." };

  let blocks = stitchBlocks(j.pages.flatMap((md) => markdownBlocks(htmlTablesToMarkdown(md))));
  // The title is already shown above the text.
  if (blocks[0] && (blocks[0].type === "h2" || blocks[0].type === "h3") && same(blocks[0].runs.map((r) => r.text).join(""), article.title)) blocks = blocks.slice(1);
  if (!blocks.some((b) => b.type === "p")) return { ok: false, error: "The careful reading came back empty. The text is unchanged." };
  // Ids from separate pages would collide; number them again in reading order.
  blocks = blocks.map((b, i) => ({ ...b, id: `b${i + 1}` }));

  const next: Article = { ...article, blocks };
  if (!(await useStore.getState().replaceText(next, wordCount(next)))) return { ok: false, error: "This browser's storage is full. The text is unchanged." };
  window.dispatchEvent(new CustomEvent("gloss:text-replaced", { detail: next }));
  return { ok: true, article: next };
}
