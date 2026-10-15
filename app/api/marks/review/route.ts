import { reviewToday } from "@/lib/marks";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

/** Today's highlights due for review, for aarOS's desk widget. `now` (epoch ms) is for tests. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("now");
  const now = raw && Number.isSafeInteger(Number(raw)) ? Number(raw) : Date.now();
  return Response.json(await reviewToday(LOCAL_USER_ID, now), { headers: { "Cache-Control": "no-store" } });
}
