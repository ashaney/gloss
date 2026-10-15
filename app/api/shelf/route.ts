import { shelfSearch } from "@/lib/mcp";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

/**
 * The shelf search, for aarOS's Kodama on this machine (the same search the MCP tool
 * search_library runs). Tailnet-only like the rest of the reader; Funnel publishes /mcp alone.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const { found, shown } = await shelfSearch(LOCAL_USER_ID, {
    query: p.get("query") ?? "",
    status: p.get("status") ?? undefined,
    topic: p.get("topic") ?? undefined,
    limit: p.get("limit") ?? undefined,
  });
  return Response.json({ total: found.length, results: shown.map(({ readInGloss: _, ...b }) => b) }, { headers: { "Cache-Control": "no-store" } });
}
