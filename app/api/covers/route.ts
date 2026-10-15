import { saveCover } from "@/lib/db";
import { isTopic } from "@/lib/library";
import { paintCover } from "@/lib/paint";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Paint a cover for one text, opt-in from the reader's settings. It is kept
 * with the library, so other devices fetch it instead of painting it again.
 * The picture comes back as a JPEG.
 */
export async function POST(req: Request) {
  let body: { id?: string; scene?: string; topic?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.slice(0, 120) : "";
  const scene = typeof body.scene === "string" ? body.scene.slice(0, 300).trim() : "";
  if (!id || !scene || !isTopic(body.topic)) return Response.json({ error: "id, scene and topic are required." }, { status: 400 });

  const r = await paintCover({ scene, topic: body.topic, signal: req.signal });
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });

  if (process.env.DATABASE_URL) await saveCover(LOCAL_USER_ID, id, r.jpeg).catch(() => {});
  return new Response(new Blob([r.jpeg as Uint8Array<ArrayBuffer>]), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
}
