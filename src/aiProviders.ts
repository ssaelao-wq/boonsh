// The AI services the assistant can use with the user's own key: Anthropic (Claude), OpenAI and Google Gemini.
// Each one is a ChatSession that keeps the conversation in that service's own message format (so whatever the
// service needs echoed back, such as Claude's thinking blocks or Gemini's thought signatures, is kept as sent).
// Claude goes through the Anthropic SDK; OpenAI and Gemini through plain HTTPS (both allow calls from the app).
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, TOOLS } from './assistant';

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};

export const KEY_PAGE: Record<ProviderId, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
};

/** What is saved in Windows Credential Manager (as JSON). */
export interface AiSettings {
  provider: ProviderId;
  key: string;
  model: string;
}

/** Read the saved value. A plain string is a key saved by the first version (Anthropic only). */
export function parseSaved(raw: string | null): AiSettings | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.key === 'string' && v.provider in PROVIDER_LABEL) return { provider: v.provider, key: v.key, model: String(v.model || '') };
  } catch {
    /* not JSON */
  }
  return { provider: detectProvider(raw) ?? 'anthropic', key: raw.trim(), model: '' };
}

/** Guess the service from the key's prefix. */
export function detectProvider(key: string): ProviderId | null {
  const k = key.trim();
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

/** A problem worth showing as is. `auth` = the key was refused (the panel opens the key form). */
export class AiError extends Error {
  constructor(message: string, public auth = false) {
    super(message);
  }
}

function httpError(status: number, body: string, provider: ProviderId): AiError {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.message ?? '';
  } catch {
    detail = body.slice(0, 200);
  }
  const name = PROVIDER_LABEL[provider];
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail)))
    return new AiError(`${name} rejected the API key. Click the key button to enter a valid key.`, true);
  if (status === 429) return new AiError(`${name}: too many requests or the quota is used up. Wait a moment, or check the account's billing.`);
  return new AiError(`${name} answered with an error (${status})${detail ? `: ${detail}` : ''}`);
}

async function getJson(url: string, init: RequestInit, provider: ProviderId): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new AiError(`Could not reach ${PROVIDER_LABEL[provider]}. Check the internet connection.`);
  }
  const text = await res.text();
  if (!res.ok) throw httpError(res.status, text, provider);
  return JSON.parse(text);
}

// ---------------------------------------------------------------- choosing the cheapest model

/** Newest first by the version numbers in the name ("gpt-5.1-nano" [5,1] before "gpt-5-nano" [5]). */
const version = (id: string) => (id.match(/\d+/g) ?? []).map(Number);
export function newestFirst(a: string, b: string): number {
  const va = version(a);
  const vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

/** The models of the key that suit the assistant, cheapest family first and newest first inside it. */
export function rankModels(provider: ProviderId, ids: string[]): string[] {
  const families: RegExp[] =
    provider === 'anthropic'
      ? [/^claude-haiku/, /^claude-sonnet/, /^claude-/]
      : provider === 'openai'
      ? [/^gpt-[\d.]+-nano$/, /^gpt-[\d.o]+-mini$/, /^gpt-[\d.o]+$/]
      : [/^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-pro$/];
  const usable = ids.filter((id) =>
    provider === 'anthropic'
      ? !/\d{8}$/.test(id) || !ids.includes(id.replace(/-\d{8}$/, ''))
      : !/(audio|realtime|search|transcribe|tts|image|live|embedding|preview|exp|thinking|codex|chat-latest|-\d{4}-\d{2}-\d{2}$)/.test(id)
  );
  const out: string[] = [];
  for (const f of families) out.push(...usable.filter((id) => f.test(id) && !out.includes(id)).sort(newestFirst));
  return out;
}

/** Check the key by listing its models (free), and return the usable ones, cheapest first. */
export async function listModels(provider: ProviderId, key: string): Promise<string[]> {
  let ids: string[] = [];
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    try {
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    } catch (err) {
      throw anthropicError(err);
    }
  } else if (provider === 'openai') {
    const j = await getJson('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }, provider);
    ids = (j.data ?? []).map((m: any) => String(m.id));
  } else {
    const j = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key } }, provider);
    ids = (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''));
  }
  const ranked = rankModels(provider, ids);
  if (ranked.length === 0) throw new AiError(`The key works, but it has no chat model the assistant can use (${PROVIDER_LABEL[provider]}).`);
  return ranked;
}

// ---------------------------------------------------------------- one conversation

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}
export interface ToolOutput {
  call: ToolCall;
  content: string;
  isError: boolean;
}
/** Tokens one request used, as the service reported them. input = input not served from the cache. */
export interface Usage {
  input: number;
  output: number; // includes thinking / reasoning tokens (billed as output)
  cacheRead: number;
  cacheWrite: number; // Anthropic only
}
export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface StepResult {
  texts: string[];
  calls: ToolCall[];
  stop: 'done' | 'tools' | 'refusal' | 'max_tokens' | 'again';
  usage: Usage;
}

/**
 * A conversation with one service. The panel calls begin(user text), then step() / addResults() until the
 * answer has no tool calls, then commit(); a stopped or failed turn is dropped with rollback(), so the saved
 * history never ends with a tool call that has no answer.
 */
export interface ChatSession {
  begin(text: string): void;
  step(signal: AbortSignal): Promise<StepResult>;
  addResults(results: ToolOutput[]): void;
  commit(): void;
  rollback(): void;
}

const MAX_OUTPUT = 4096;

function anthropicError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new AiError('Anthropic rejected the API key. Click the key button to enter a valid key.', true);
  if (err instanceof Anthropic.RateLimitError) return new AiError('Anthropic: too many requests. Wait a moment and try again.');
  if (err instanceof Anthropic.APIConnectionError) return new AiError('Could not reach Anthropic. Check the internet connection.');
  if (err instanceof Anthropic.APIError) return new AiError(`Anthropic answered with an error${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  return err;
}

class AnthropicSession implements ChatSession {
  private history: Anthropic.MessageParam[] = [];
  private turn: Anthropic.MessageParam[] = [];
  private client: Anthropic;
  constructor(key: string, private model: string) {
    this.client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }
  begin(text: string) {
    this.turn = [{ role: 'user', content: text }];
  }
  async step(signal: AbortSignal): Promise<StepResult> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          output_config: { effort: 'low' },
          cache_control: { type: 'ephemeral' },
          messages: [...this.history, ...this.turn],
        },
        { signal }
      );
    } catch (err) {
      throw anthropicError(err);
    }
    this.turn.push({ role: 'assistant', content: res.content });
    const texts = res.content.flatMap((b) => (b.type === 'text' && b.text.trim() ? [b.text.trim()] : []));
    const calls = res.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []));
    const stop =
      res.stop_reason === 'refusal' ? 'refusal' : res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason === 'pause_turn' ? 'again' : res.stop_reason === 'tool_use' && calls.length ? 'tools' : 'done';
    const u = res.usage;
    const usage = { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens) };
    return { texts, calls, stop, usage };
  }
  addResults(results: ToolOutput[]) {
    this.turn.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
    });
  }
  commit() {
    this.history.push(...this.turn);
    this.turn = [];
  }
  rollback() {
    this.turn = [];
  }
}

// OpenAI Chat Completions: tools as functions, results as role "tool" messages.
const OPENAI_TOOLS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

class OpenAISession implements ChatSession {
  private history: any[] = [];
  private turn: any[] = [];
  // reasoning models (gpt-5 family, o-series) think less and cost less at low effort; others refuse the field
  private effort: boolean;
  constructor(private key: string, private model: string) {
    this.effort = /^(o\d|gpt-5)/.test(model);
  }
  begin(text: string) {
    this.turn = [{ role: 'user', content: text }];
  }
  async step(signal: AbortSignal): Promise<StepResult> {
    const body: any = {
      model: this.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history, ...this.turn],
      tools: OPENAI_TOOLS,
      max_completion_tokens: MAX_OUTPUT,
    };
    if (this.effort) body.reasoning_effort = 'low';
    let j: any;
    try {
      j = await getJson('https://api.openai.com/v1/chat/completions', { method: 'POST', signal, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'openai');
    } catch (err) {
      if (this.effort && err instanceof AiError && /reasoning_effort/.test(err.message)) {
        this.effort = false;
        return this.step(signal);
      }
      throw err;
    }
    const choice = j.choices?.[0] ?? {};
    const m = choice.message ?? { role: 'assistant', content: '' };
    this.turn.push({ role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
    const calls: ToolCall[] = (m.tool_calls ?? []).map((c: any) => {
      let input: any = {};
      try {
        input = JSON.parse(c.function?.arguments || '{}');
      } catch {
        input = {};
      }
      return { id: c.id, name: c.function?.name, input };
    });
    const texts = typeof m.content === 'string' && m.content.trim() ? [m.content.trim()] : [];
    if (m.refusal) texts.push(String(m.refusal));
    const fr = choice.finish_reason;
    const stop = fr === 'content_filter' || m.refusal ? 'refusal' : fr === 'length' ? 'max_tokens' : calls.length ? 'tools' : 'done';
    // prompt_tokens includes the cached part; completion_tokens includes reasoning
    const cached = n(j.usage?.prompt_tokens_details?.cached_tokens);
    const usage = { input: Math.max(0, n(j.usage?.prompt_tokens) - cached), output: n(j.usage?.completion_tokens), cacheRead: cached, cacheWrite: 0 };
    return { texts, calls, stop, usage };
  }
  addResults(results: ToolOutput[]) {
    for (const r of results) this.turn.push({ role: 'tool', tool_call_id: r.call.id, content: r.content });
  }
  commit() {
    this.history.push(...this.turn);
    this.turn = [];
  }
  rollback() {
    this.turn = [];
  }
}

// Gemini generateContent: function declarations; the model's content is echoed back exactly (thought signatures).
const GEMINI_TOOLS = [
  {
    functionDeclarations: TOOLS.map((t) => {
      const schema = t.input_schema as any;
      const hasParams = schema.properties && Object.keys(schema.properties).length > 0;
      return { name: t.name, description: t.description, ...(hasParams ? { parameters: schema } : {}) };
    }),
  },
];

class GeminiSession implements ChatSession {
  private history: any[] = [];
  private turn: any[] = [];
  private seq = 0;
  constructor(private key: string, private model: string) {}
  begin(text: string) {
    this.turn = [{ role: 'user', parts: [{ text }] }];
  }
  async step(signal: AbortSignal): Promise<StepResult> {
    const j = await getJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        signal,
        headers: { 'x-goog-api-key': this.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [...this.history, ...this.turn],
          tools: GEMINI_TOOLS,
          generationConfig: { maxOutputTokens: MAX_OUTPUT },
        }),
      },
      'gemini'
    );
    // promptTokenCount includes the cached part; thinking is counted apart from the answer but billed as output
    const um = j.usageMetadata ?? {};
    const cached = n(um.cachedContentTokenCount);
    const usage = { input: Math.max(0, n(um.promptTokenCount) - cached), output: n(um.candidatesTokenCount) + n(um.thoughtsTokenCount), cacheRead: cached, cacheWrite: 0 };
    const cand = j.candidates?.[0];
    if (!cand || j.promptFeedback?.blockReason) return { texts: [], calls: [], stop: 'refusal', usage };
    const content = cand.content ?? { role: 'model', parts: [] };
    const parts: any[] = content.parts ?? [];
    this.turn.push({ role: 'model', parts });
    const texts = parts.flatMap((p) => (typeof p.text === 'string' && !p.thought && p.text.trim() ? [p.text.trim()] : []));
    const calls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: p.functionCall.id ?? `boonsh-call-${++this.seq}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }));
    const fr = cand.finishReason;
    const stop = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(fr) ? 'refusal' : fr === 'MAX_TOKENS' ? 'max_tokens' : calls.length ? 'tools' : 'done';
    return { texts, calls, stop, usage };
  }
  addResults(results: ToolOutput[]) {
    this.turn.push({
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: { name: r.call.name, ...(r.call.id.startsWith("boonsh-call-") ? {} : { id: r.call.id }), response: r.isError ? { error: r.content } : { result: r.content } },
      })),
    });
  }
  commit() {
    this.history.push(...this.turn);
    this.turn = [];
  }
  rollback() {
    this.turn = [];
  }
}

export function createSession(s: AiSettings): ChatSession {
  if (s.provider === 'openai') return new OpenAISession(s.key, s.model);
  if (s.provider === 'gemini') return new GeminiSession(s.key, s.model);
  return new AnthropicSession(s.key, s.model);
}
