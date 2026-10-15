/**
 * A painted cover for one text, on the server: the scene the classifier
 * wrote, as a two-colour risograph print in its topic's inks. The title is
 * never in the prompt, or the model letters it onto the picture.
 */

import { TOPIC, type TopicKey } from "./library";
import { APP_UA } from "./muse";

/** What one Muse Image cover costs. */
export const COVER_USD = 0.01;

export async function paintCover(req: { scene: string; topic: TopicKey; signal?: AbortSignal }): Promise<{ ok: true; jpeg: Uint8Array } | { ok: false; error: string }> {
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) return { ok: false, error: "No Muse API key on the server. Set MODEL_API_KEY in .env.local." };
  const prompt = `Editorial risograph print. ${req.scene.replace(/\.?$/, ".")} Two-colour palette of ${TOPIC[req.topic].inks} ink on warm cream paper filling the whole image, grain and halftone texture, mid-century book-cover illustration, wordless, no lettering, no border.`;
  let res: Response;
  try {
    res = await fetch("https://api.meta.ai/v1/images/generations", {
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": APP_UA },
      body: JSON.stringify({ model: "muse-image-1.0", prompt, output_format: "jpeg" }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Muse Image: ${String(e)}` };
  }
  const j = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { message?: string } };
  const b64 = j.data?.[0]?.b64_json;
  if (!res.ok || !b64) return { ok: false, error: j.error?.message ?? `Muse Image answered ${res.status}.` };
  return { ok: true, jpeg: Uint8Array.from(Buffer.from(b64, "base64")) };
}
