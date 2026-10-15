import { classify, type ShelveInput } from "@/lib/shelve";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Sort one text onto the library's shelves: a topic, a few tags and a scene for its cover. */
export async function POST(req: Request) {
  let body: ShelveInput;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.title !== "string" || !body.title.trim()) return Response.json({ error: "title is required." }, { status: 400 });
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const input: ShelveInput = { title: body.title.slice(0, 300), author: str(body.author, 200), source: str(body.source, 200), dek: str(body.dek, 600), excerpt: str(body.excerpt, 3000) };

  const r = await classify(input, { signal: req.signal });
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return Response.json(r.shelving);
}
