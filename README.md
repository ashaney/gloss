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
tailnet over HTTPS (never Funnel):

```bash
npm run build
systemctl --user enable --now gloss.service   # next start on 127.0.0.1:3100
tailscale serve --bg --https=8443 http://127.0.0.1:3100
# -> https://mori.tail26dff.ts.net:8443
```

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
