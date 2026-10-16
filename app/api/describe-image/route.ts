import { completeChat, MODELS } from "@/lib/muse";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * What a picture shows, for aarOS's image library: a one-sentence caption, a few tags and the
 * text legible in it, read by Muse Spark. Tailnet-only, like /api/shelf. The hub sends a JPEG
 * at most 1024 px on its long side, and asks again later when this answers 502.
 */
const MAX_IMAGE_CHARS = 3_500_000;
/** Longer than a picture ever takes; the hub's own timeout should sit above it. */
const MODEL_MS = 75_000;

const PROMPT = `Describe this picture for a personal image library. Reply with JSON only:
{"caption": "...", "tags": ["..."], "text": "..."}
- caption: one plain sentence under 160 characters saying what the picture shows. Start with the subject, not "This image shows".
- tags: 3 to 8 lowercase single words or short phrases: the main objects, materials, colours or style, and what kind of picture it is (photo, screenshot, illustration, painting, poster, diagram, chart, map, ui, product, logo, meme).
- text: the words legible in the picture, as written, at most 300 characters; "" if there are none.`;

/** One line, at most `max` characters, cut at a word. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).replace(/\s+\S*$/, "")}...` : t;
}

/** The answer's JSON, wherever the model put it: after its reasoning, inside a fence, or bare. */
function parse(raw: string): { caption?: unknown; tags?: unknown; text?: unknown } | null {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (t.includes("</think>")) t = t.slice(t.lastIndexOf("</think>") + 8);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j: unknown = JSON.parse(t.slice(start, end + 1));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { image?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const image = typeof body?.image === "string" ? body.image : "";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]/.test(image)) return Response.json({ error: "Send the picture as a data URL: data:image/jpeg;base64,..." }, { status: 400 });
  if (image.length > MAX_IMAGE_CHARS) return Response.json({ error: "That picture is too large. Send it at most 1024 px on its long side." }, { status: 413 });

  const result = await completeChat({
    model: MODELS.spark.id,
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(MODEL_MS)]),
    temperature: 0,
    maxTokens: 600,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: image } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  }).catch((e: unknown) => ({ ok: false as const, error: `Muse did not finish: ${e instanceof Error ? e.message : String(e)}` }));
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });

  const j = parse(result.text);
  const caption = typeof j?.caption === "string" ? clip(j.caption.replace(/^["']|["']$/g, ""), 160) : "";
  if (!caption) return Response.json({ error: "Muse answered without a caption. Try again." }, { status: 502 });
  const tags: string[] = [];
  for (const t of Array.isArray(j?.tags) ? j.tags : []) {
    if (typeof t !== "string") continue;
    const s = t.toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N} '&+.-]/gu, " ").replace(/\s+/g, " ").trim();
    if (s && s.length <= 32 && !tags.includes(s)) tags.push(s);
    if (tags.length === 8) break;
  }
  // A model with nothing to read sometimes says so in words.
  const text = typeof j?.text === "string" && !/^(none|n\/a|no text|null)\.?$/i.test(j.text.trim()) ? clip(j.text, 300) : "";
  return Response.json({ caption, tags, text }, { headers: { "Cache-Control": "no-store" } });
}
