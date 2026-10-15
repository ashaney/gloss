import { completeChat, MODELS } from "@/lib/muse";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * One PDF page the text layer cannot give us (a scan, an image of text, garbled
 * glyphs), read by Muse Spark into Markdown.
 * mode "layout": a page whose text layer reads but whose layout came out
 * badly (columns, tables, maths), read again in the background (lib/upgrade.ts).
 */
const MAX_IMAGE_CHARS = 3_500_000;

const PROMPT = `Transcribe this document page into clean Markdown, in reading order.
- Multiple columns: the whole left column first, then the next.
- Keep each paragraph whole on one line; join words hyphenated across line breaks.
- # and ## for headings, - for list items, Markdown tables for tables.
- Leave out page numbers, running headers and footers.
- For a picture or chart, write its caption only, if it has one. Never write image links.
- Write only what is on the page. No commentary, no code fences around the whole.`;

const LAYOUT_PROMPT = `${PROMPT}
- Maths as LaTeX between $ signs, inline, or $$ on its own line for a displayed equation.
- Keep equation numbers such as (3) beside their equation.`;

/** Reasoning some models print into the answer, and fences some wrap it in. */
function clean(md: string): string {
  let t = md.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (t.includes("</think>")) t = t.slice(t.lastIndexOf("</think>") + 8);
  return t
    .replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1")
    // Author marks written as LaTeX ($^{1,2}$, $^{\dagger}$) read better as plain text.
    .replace(/\$\^\{?([^}$]{1,24})\}?\$/g, (_, m: string) => m.replace(/\\dagger/g, "†").replace(/\\ddagger/g, "‡").replace(/\\ast|\*/g, "\\*"))
    .replace(/^!\[[^\]]*\]\([^)]*\)\s*$/gm, "")
    .trim();
}

export async function POST(req: Request) {
  let body: { image?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const image = body.image ?? "";
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) return Response.json({ error: "Send the page as an image." }, { status: 400 });
  if (image.length > MAX_IMAGE_CHARS) return Response.json({ error: "That page image is too large." }, { status: 413 });

  const layout = body.mode === "layout";
  const result = await completeChat({
    model: MODELS.spark.id,
    signal: req.signal,
    temperature: 0,
    maxTokens: 4096,
    ...(layout ? { reasoningEffort: "medium" as const } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: image } },
          { type: "text", text: layout ? LAYOUT_PROMPT : PROMPT },
        ],
      },
    ],
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });
  return Response.json({ markdown: clean(result.text) });
}
