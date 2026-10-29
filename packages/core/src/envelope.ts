import { z } from 'zod';
import { AGENT_KINDS, INGEST_MAX_BATCH } from './constants.js';
import type { Envelope, EnvelopeEnv } from './types.js';

/** Result of validating a POST /api/ingest body. */
export interface ParsedEnvelopes {
  /** Valid envelopes in input order. */
  envelopes: Envelope[];
  /** Items that failed validation (skipped, never an HTTP error). */
  ignored: number;
}

/** Thrown when an array body has more than INGEST_MAX_BATCH items (HTTP 413). */
export class TooManyEnvelopesError extends Error {
  constructor(readonly count: number) {
    super(`too many envelopes: ${count}`);
    this.name = 'TooManyEnvelopesError';
  }
}

const ENV_KEYS = ['herdr_pane_id', 'herdr_tab_id', 'herdr_workspace_id', 'tmux_pane'] as const;

// Env values: non-string / empty values are dropped (= absent) instead of
// failing the whole envelope; unknown keys are ignored.
const envSchema = z.record(z.string(), z.unknown()).transform((raw): EnvelopeEnv => {
  const env: EnvelopeEnv = {};
  for (const k of ENV_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return env;
});

const envelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  agent: z.enum(AGENT_KINDS),
  hostname: z.string().optional(),
  pid: z.number().int().optional(),
  env: envSchema.optional(),
  // Hook stdin / omp canonical event: always a JSON object.
  payload: z.record(z.string(), z.unknown()),
});

/** Validate one item; null when invalid. Unknown top-level keys are dropped. */
export function parseEnvelope(item: unknown): Envelope | null {
  const r = envelopeSchema.safeParse(item);
  if (!r.success) return null;
  const d = r.data;
  const env: Envelope = { v: 1, id: d.id, ts: d.ts, agent: d.agent, payload: d.payload };
  if (d.hostname !== undefined && d.hostname !== '') env.hostname = d.hostname;
  if (d.pid !== undefined) env.pid = d.pid;
  if (d.env !== undefined) env.env = d.env;
  return env;
}

/**
 * Accepts a single envelope object or an array (<= INGEST_MAX_BATCH).
 * Invalid items are counted in `ignored`; a non-object/non-array body yields
 * `{ envelopes: [], ignored: 1 }`. Throws TooManyEnvelopesError for oversize arrays.
 */
export function parseEnvelopes(body: unknown): ParsedEnvelopes {
  if (Array.isArray(body)) {
    if (body.length > INGEST_MAX_BATCH) throw new TooManyEnvelopesError(body.length);
    const envelopes: Envelope[] = [];
    let ignored = 0;
    for (const item of body) {
      const e = parseEnvelope(item);
      if (e) envelopes.push(e);
      else ignored += 1;
    }
    return { envelopes, ignored };
  }
  const e = parseEnvelope(body);
  return e ? { envelopes: [e], ignored: 0 } : { envelopes: [], ignored: 1 };
}
