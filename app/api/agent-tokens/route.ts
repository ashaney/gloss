import { makeToken } from "@/lib/agent";
import { createToken, listTokens, revokeToken } from "@/lib/db";
import { LOCAL_USER_ID } from "@/lib/user";

export const runtime = "nodejs";

const MAX_TOKENS = 10;

/** The reader's agent connections: list them, make one (its token shown once), or revoke one. */
export async function GET() {
  return Response.json({ tokens: await listTokens(LOCAL_USER_ID) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  if ((await listTokens(LOCAL_USER_ID)).length >= MAX_TOKENS) return Response.json({ error: `You have ${MAX_TOKENS} connections. Revoke one first.` }, { status: 409 });
  const t = makeToken();
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 40) : "Agent";
  await createToken(LOCAL_USER_ID, t.id, t.hash, label);
  return Response.json({ id: t.id, label, token: t.token });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return (await revokeToken(LOCAL_USER_ID, id)) ? Response.json({ ok: true }) : Response.json({ error: "Not found." }, { status: 404 });
}
