import { loadCover } from "@/lib/db";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

/** A cover painted on another device, from the reader's library. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const jpeg = await loadCover(LOCAL_USER_ID, (await params).id);
  if (!jpeg) return Response.json({ error: "Not found." }, { status: 404 });
  return new Response(new Blob([jpeg as Uint8Array<ArrayBuffer>]), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
}
