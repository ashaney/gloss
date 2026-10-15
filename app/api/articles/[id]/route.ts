import { articleDoc } from "@/lib/db";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

/** One imported text from the reader's library, for a device that has the shelf entry but not the text. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const doc = await articleDoc(LOCAL_USER_ID, (await params).id);
  if (!doc) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json({ doc });
}
