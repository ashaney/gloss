import { marksBetween } from "@/lib/marks";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

const MAX_SPAN = 31 * 86_400_000;

/**
 * What the reader marked in (from, to], epoch milliseconds: for aarOS's nightly
 * journal entry. Tailnet-only like the rest of the reader; Funnel publishes /mcp alone.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const from = Number(p.get("from"));
  const to = Number(p.get("to"));
  if (!p.get("from") || !p.get("to") || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from)
    return Response.json({ error: "from and to must be epoch milliseconds, from before to." }, { status: 400 });
  if (to - from > MAX_SPAN) return Response.json({ error: "At most 31 days at a time." }, { status: 400 });
  return Response.json(await marksBetween(LOCAL_USER_ID, from, to));
}
