// The app's own PDF import as a fifth reader in the PDF eval: what a reader gets today with no extra step
// (LiteParse in the browser, plus Qwen3.8 Flash for pages with no usable text).
//
// For each page from run.py, it drops out/<page>/page.pdf on the landing page in headless Chrome, reads the
// imported text back from IndexedDB and writes it as Markdown to out/<page>/gloss-today.md, with the time taken.
// Needs the app running (npm run dev) and Google Chrome; the app reads scanned pages on its
// server-side Muse key, so no browser key is involved.
//   node scripts/pdf-eval/app-import.mjs [outdir] [baseUrl] [--wait]
// --wait stays on the reader until the background page upgrades (lib/upgrade.ts) finish, and writes that
// reading as gloss-hybrid.md instead: what a reader has half a minute after opening a PDF.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const WAIT = process.argv.includes("--wait");
const OUT = resolve(args[0] ?? new URL("./out", import.meta.url).pathname);
const BASE = args[1] ?? "http://localhost:3100";
const NAME = WAIT ? "gloss-hybrid" : "gloss-today";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "gloss-pdf-eval-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9343", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const page = (await (await fetch("http://127.0.0.1:9343/json")).json()).find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  await sleep(250);
}
if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m.result), pending.delete(m.id);
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");

/** Blocks back to Markdown, so the judge sees the same kind of output from every reader. */
function toMarkdown(article) {
  const inline = (runs) =>
    runs
      .map((r) => {
        let t = r.text;
        if (r.code) t = `\`${t}\``;
        if (r.strong) t = `**${t}**`;
        if (r.em) t = `*${t}*`;
        if (r.href) t = `[${t}](${r.href})`;
        return t;
      })
      .join("");
  const out = [];
  if (article.title && !/^page$/i.test(article.title.trim())) out.push(`# ${article.title}`);
  for (const b of article.blocks) {
    if (b.type === "h2") out.push(`## ${inline(b.runs)}`);
    else if (b.type === "h3") out.push(`### ${inline(b.runs)}`);
    else if (b.type === "quote") out.push(`> ${inline(b.runs)}`);
    else if (b.type === "li") out.push(`- ${inline(b.runs)}`);
    else if (b.type === "pre") out.push("```\n" + inline(b.runs) + "\n```");
    else if (b.type === "note") out.push(`*${inline(b.runs)}*`);
    else if (b.type === "figure") out.push(`[Figure${b.alt ? `: ${b.alt}` : ""}]`);
    else if (b.type === "table" && b.rows?.length) {
      const w = Math.max(...b.rows.map((r) => r.length));
      const line = (r) => `| ${[...r, ...Array(w - r.length).fill("")].join(" | ")} |`;
      out.push([line(b.rows[0]), line(Array(w).fill("---")), ...b.rows.slice(1).map(line)].join("\n"));
    } else out.push(inline(b.runs));
  }
  return out.join("\n\n") + "\n";
}

const pages = readdirSync(OUT).filter((d) => existsSync(join(OUT, d, "page.pdf")));
const timing = {};
for (const id of pages) {
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(3000);
  const doc = await send("DOM.getDocument", { depth: -1 });
  const input = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
  const t0 = Date.now();
  await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [join(OUT, id, "page.pdf")] });
  let path = "";
  for (let i = 0; i < 240 && !path.startsWith("/read/"); i++) {
    await sleep(500);
    path = (await evaluate("location.pathname")) ?? "";
  }
  const seconds = (Date.now() - t0) / 1000;
  if (!path.startsWith("/read/")) {
    const shown = await evaluate(`document.querySelector('[role=alert]')?.textContent ?? ''`);
    writeFileSync(join(OUT, id, `${NAME}.md`), "");
    timing[id] = { seconds, error: shown || "import did not finish" };
    console.log(`${id.padEnd(20)} FAILED ${shown}`);
    continue;
  }
  const articleId = decodeURIComponent(path.slice("/read/".length));
  const read = () => evaluate(`new Promise((resolve) => {
    const req = indexedDB.open("gloss", 2);
    req.onsuccess = () => {
      const get = req.result.transaction("docs", "readonly").objectStore("docs").get(${JSON.stringify(articleId)});
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  })`);
  let article = await read();
  const flagged = article?.upgrade ?? [];
  if (WAIT && flagged.length) for (let i = 0; i < 120 && article?.upgrade?.length; i++) await sleep(1000), (article = await read());
  const upgraded = (article?.blocks ?? []).some((b) => String(b.id).startsWith("u"));
  writeFileSync(join(OUT, id, `${NAME}.md`), article ? toMarkdown(article) : "");
  timing[id] = { seconds: WAIT ? (Date.now() - t0) / 1000 : seconds, blocks: article?.blocks?.length ?? 0, flagged: flagged.length > 0, upgraded };
  console.log(`${id.padEnd(20)} ${timing[id].seconds.toFixed(1)}s  ${article?.blocks?.length ?? 0} blocks${flagged.length ? (upgraded ? "  upgraded" : "  flagged, kept") : ""}`);
}
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(timing, null, 2));
ws.close();
chrome.kill();
