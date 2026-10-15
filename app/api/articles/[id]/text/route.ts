import { blockText, modelText, type Article, type Block } from "@/lib/article";
import { articleDoc } from "@/lib/db";
import { sampleById } from "@/lib/samples";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

const MAX = 30_000;
const CAP = 60_000;

/** A block as plain text: headings and list items marked the Markdown way, figures by caption. */
function plain(b: Block): string {
  const t = blockText(b).trim();
  switch (b.type) {
    case "h2":
    case "h3":
      return t && `## ${t}`;
    case "li":
      return t && `- ${t}`;
    case "quote":
      return t && `> ${t}`;
    case "table":
      return modelText(b);
    case "figure":
      return t && `[Figure: ${t}]`;
    default:
      return t;
  }
}

/**
 * One text from the library as plain text, a chunk at a time, for aarOS's Kodama on this
 * machine. `offset` and `max` are characters; `next_offset` is null at the end.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const doc = ((await articleDoc(LOCAL_USER_ID, id)) as Article | null) ?? sampleById(id);
  if (!doc) return Response.json({ error: "Not found." }, { status: 404 });

  const text = doc.blocks.map(plain).filter(Boolean).join("\n\n");
  const q = new URL(req.url).searchParams;
  const max = Math.min(CAP, Math.max(1, Number(q.get("max")) || MAX));
  const offset = Math.min(text.length, Math.max(0, Math.floor(Number(q.get("offset")) || 0)));
  let end = Math.min(text.length, offset + max);
  // End a chunk at a paragraph or a space when one is near, so words aren't cut in two.
  if (end < text.length) {
    const cut = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf(" ", end));
    if (cut > offset + max * 0.8) end = cut;
  }
  return Response.json(
    {
      id,
      title: doc.title,
      author: doc.author,
      source: doc.source,
      url: doc.sourceUrl,
      chars: text.length,
      offset,
      text: text.slice(offset, end),
      next_offset: end < text.length ? end : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
