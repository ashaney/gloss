import { shelfOf } from "@/lib/db";
import { saveLink, shelfByUrl } from "@/lib/mcp";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";
export const maxDuration = 300;

/** No bookmark is older than the web, and none comes from the future: anything else is seconds sent as milliseconds. */
const EARLIEST = Date.UTC(1990, 0, 1);

/**
 * One link from aarOS's Library onto the shelf, by the road the MCP tool save_articles takes,
 * but as the reader's own import: no daily limit, not marked as an agent's, and shelved on the
 * day it was bookmarked (`addedAt`, epoch ms) instead of today. Tailnet-only, like /api/shelf.
 *
 * Answers 200 with what became of the link, `kind` saying why one failed. 400 is a body it
 * can't use; 503 is Gloss's own library failing, so the link was not judged at all.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Body must be a JSON object." }, { status: 400 });

  const { url, addedAt, tags, via } = body;
  if (typeof url !== "string" || !url.trim() || url.length > 4000) return Response.json({ error: "Send the link in `url`." }, { status: 400 });
  if (addedAt !== undefined && (typeof addedAt !== "number" || !Number.isFinite(addedAt) || addedAt < EARLIEST || addedAt > Date.now() + 86_400_000)) {
    return Response.json({ error: "`addedAt` must be the time it was bookmarked, in milliseconds since 1970." }, { status: 400 });
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) return Response.json({ error: "`tags` must be a list of strings." }, { status: 400 });
  if (via !== undefined && typeof via !== "string") return Response.json({ error: "`via` must be a string." }, { status: 400 });

  try {
    const have = shelfByUrl(await shelfOf(LOCAL_USER_ID));
    const r = await saveLink(LOCAL_USER_ID, url.trim(), have, {
      at: addedAt === undefined ? undefined : Math.round(addedAt),
      tags: tags as string[] | undefined,
      via: via?.trim().slice(0, 60) || undefined,
    });
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // Reading a page never throws (fetchArticle answers every failure), so this is the database.
    console.error("shelf/import:", e);
    return Response.json({ error: "The Gloss library is not reachable right now. Try again in a minute." }, { status: 503 });
  }
}
