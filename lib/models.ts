/**
 * The model allow-list and wire types. Safe to import on the client: no keys,
 * no fetches. lib/muse.ts does the network side.
 */

export type ModelEntry = {
  id: string;
  label: string;
  short: string;
  blurb: string;
  inPerM: number;
  cachedPerM: number;
  outPerM: number;
};

/**
 * One model: Muse Spark 1.3 on Meta's Model API (Standard tier, so prompts
 * and completions are never used for training). There used to be a choice of
 * open models on Together; this fork is single-reader, single-provider.
 * Anything that looks a model up goes through modelOf(), which falls back
 * to Spark for a saved key that is no longer on the list.
 */
export const MODELS = {
  spark: {
    id: "muse-spark-1.3",
    label: "Muse Spark 1.3",
    short: "Spark",
    blurb: "Meta's Muse Spark. Reasons briefly, then answers in the margin.",
    inPerM: 1.25,
    cachedPerM: 0.15,
    outPerM: 4.25,
  },
} as const satisfies Record<string, ModelEntry>;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "spark";

export function isModelKey(v: unknown): v is ModelKey {
  return typeof v === "string" && v in MODELS;
}

/** A model key that is still on the list: a saved key from another provider era becomes Spark. */
export const modelOf = (v: unknown): ModelKey => (isModelKey(v) ? v : DEFAULT_MODEL);

export type Usage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
};

/** Dollars for a run. Cached prompt tokens bill at the cached rate. */
export function costFor(key: ModelKey, prompt: number, cached: number, completion: number): number {
  const m: ModelEntry = MODELS[key];
  const fresh = Math.max(0, prompt - cached);
  return (fresh * m.inPerM + cached * m.cachedPerM + completion * m.outPerM) / 1_000_000;
}

/** A web result an answer can cite as [n]. */
export type Source = { n: number; title: string; url: string; site: string; date?: string };

export type StreamEvent =
  | { type: "meta"; model: string }
  | { type: "searching" }
  /** The model asked for a tool (web search); the route runs it and asks again. Never sent to the browser. */
  | { type: "tool"; id: string; name: string; args: string }
  /** Drop what was written so far: a line before a tool call ("I'll look that up") that the real answer replaces. */
  | { type: "reset" }
  | { type: "sources"; sources: Source[] }
  | { type: "content"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done" }
  | { type: "error"; text: string };
