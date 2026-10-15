<a href="https://usegloss.io">
  <img alt="Gloss" src="./public/og.png">
  <h1 align="center">Gloss</h1>
</a>

<p align="center">
  An open source AI reader for articles and PDFs. Select any line, ask a question, and get a cited answer in the margin. Powered by Muse Spark on Meta's Model API.
</p>

> **This fork** (of [Nutlope/gloss](https://github.com/Nutlope/gloss)) is a single-reader,
> self-hosted variant built to run on one machine behind Tailscale:
> Together AI is replaced by Meta's Muse API, Clerk auth is removed (the tailnet
> is the gate; there is one fixed local user), Neon is replaced by a local
> Postgres, painted covers use Muse Image, and the Together TTS "Listen"
> feature is dropped (Muse has no text-to-speech). Exa web search is unchanged.
> See "Running on mori" below.

## Tech stack

- [Muse Spark 1.3](https://developer.meta.ai/docs/models) for margin answers, briefs, and scanned-page reading; [Muse Image](https://developer.meta.ai/docs/models) for painted covers
- [Exa](https://exa.ai) for web search
- [LiteParse](https://github.com/run-llama/liteparse) for in-browser PDF parsing, with Muse Spark vision for scanned pages
- Local Postgres for syncing your library across your own devices (no accounts)
- Next.js app router with Tailwind

## Cloning & running

1. Clone the repo: `git clone https://github.com/ashaney/gloss`

2. Create a `.env.local` file (use `.env.example` for reference) and add:
   - **Meta Model API key**: `MODEL_API_KEY=`
   - **Database URL** for Postgres: `DATABASE_URL=`
   - **Exa API key** (optional, for web search): `EXA_API_KEY=`
3. Run `npm install` and `npm run db:migrate` to install dependencies and create the tables
4. Run `npm run dev` and open http://localhost:3100

## Running on mori

Production runs as a user service bound to loopback only, published to the
tailnet over HTTPS (Funnel is used for the MCP endpoint only, below):

```bash
npm run build
systemctl --user enable --now gloss.service   # next start on 127.0.0.1:3100
tailscale serve --bg --https=8443 http://127.0.0.1:3100
# -> https://mori.tail26dff.ts.net:8443
```

Cloud agents (Grok Bot, claude.ai) can't join the tailnet, so only the MCP
endpoint is also published publicly via Tailscale Funnel, on its own port and
path. Everything else (reader, sync, library) stays tailnet-only, and the
MCP token (`gls_…`, hashed in Postgres, revocable in the Library) is the auth:

```bash
# Funnel's public ingress only supports ports 443, 8443 and 10000. Port 10000
# is dedicated to MCP here so the reader's :8443 port remains tailnet-only.
tailscale funnel --bg --https=10000 --set-path /mcp http://127.0.0.1:3100/mcp
# -> https://mori.tail26dff.ts.net:10000/mcp   (Bearer token required)
tailscale funnel --https=10000 off   # close the public door
```

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
