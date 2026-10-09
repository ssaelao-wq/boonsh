// What the AI Assistant's requests cost: token counts come from the services (exact), prices from a small
// built-in list (public price lists, October 2026) or from the user, who can set the price of any model.
// The cost is an estimate: services change prices, and taxes, free tiers and discounts are not known here.

import type { ProviderId } from './aiProviders';
import type { Usage } from './aiProviders';

/** US dollars per 1 million tokens */
export interface Price {
  input: number;
  output: number;
}

// Only models whose price several public lists agreed on. Anything else shows tokens until the user sets a price.
// Keys are model ids; a dated id (gpt-5-nano-2025-08-07) uses its base id's price.
const BUILT_IN: Record<string, Price> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
};

// Cached input is billed at a fraction of the input price (reads: about 10% at all three services);
// Anthropic also bills writing the cache at 125%.
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

export const PRICE_PAGE: Record<ProviderId, string> = {
  anthropic: 'https://www.anthropic.com/pricing#api',
  openai: 'https://openai.com/api/pricing/',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
};

const PRICES_KEY = 'boonsh_ai_prices'; // the user's own prices: { [model]: Price }

export function loadUserPrices(): Record<string, Price> {
  try {
    const v = JSON.parse(localStorage.getItem(PRICES_KEY) ?? '{}');
    const out: Record<string, Price> = {};
    for (const [k, p] of Object.entries(v ?? {})) {
      const q = p as Price;
      if (isPrice(q)) out[k] = { input: q.input, output: q.output };
    }
    return out;
  } catch {
    return {};
  }
}
export function saveUserPrices(prices: Record<string, Price>) {
  try {
    localStorage.setItem(PRICES_KEY, JSON.stringify(prices));
  } catch {
    /* storage blocked: the price holds until boonsh closes */
  }
}
const isPrice = (p: unknown): p is Price =>
  !!p && typeof (p as Price).input === 'number' && typeof (p as Price).output === 'number' && (p as Price).input >= 0 && (p as Price).output >= 0;

/** The built-in price of a model, also for a dated id of it. */
export function builtInPrice(model: string): Price | null {
  const m = model.toLowerCase().replace(/^models\//, '');
  if (BUILT_IN[m]) return BUILT_IN[m];
  const base = m.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '').replace(/-\d{3}$/, '');
  return BUILT_IN[base] ?? null;
}

/** The price in use: the user's own, else the built-in one, else none (tokens only). */
export function priceFor(model: string, user: Record<string, Price>): { price: Price; own: boolean } | null {
  if (user[model]) return { price: user[model], own: true };
  const b = builtInPrice(model);
  return b ? { price: b, own: false } : null;
}

/** Dollars for the tokens at the price. */
export function costOf(u: Usage, p: Price): number {
  const perToken = (x: number) => x / 1_000_000;
  return (
    perToken(u.input) * p.input + perToken(u.cacheRead) * p.input * CACHE_READ + perToken(u.cacheWrite) * p.input * CACHE_WRITE + perToken(u.output) * p.output
  );
}

export const totalTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** 950, 12.3k, 1.25M */
export function formatTokens(x: number): string {
  if (x < 1000) return String(x);
  if (x < 1_000_000) return `${(x / 1000).toFixed(x < 10_000 ? 1 : 0)}k`;
  return `${(x / 1_000_000).toFixed(2)}M`;
}

/** $0.0042, $0.13, $2.40 (small amounts keep enough digits to be readable) */
export function formatCost(d: number): string {
  if (d === 0) return '$0';
  if (d < 0.0001) return '<$0.0001';
  if (d < 0.01) return `$${d.toFixed(4)}`;
  if (d < 1) return `$${d.toFixed(3)}`;
  return `$${d.toFixed(2)}`;
}

/** The tooltip text: every kind of token, and how the cost was worked out. */
export function usageDetail(u: Usage, priced: { price: Price; own: boolean } | null): string {
  const lines = [
    `Input: ${u.input.toLocaleString()} tokens`,
    `Output (with thinking): ${u.output.toLocaleString()} tokens`,
  ];
  if (u.cacheRead) lines.push(`Input read from the cache: ${u.cacheRead.toLocaleString()} tokens (about 10% of the input price)`);
  if (u.cacheWrite) lines.push(`Input written to the cache: ${u.cacheWrite.toLocaleString()} tokens (125% of the input price)`);
  if (priced) {
    lines.push(
      `About ${formatCost(costOf(u, priced.price))} at $${priced.price.input} input / $${priced.price.output} output per 1M tokens (${priced.own ? 'your price' : 'built-in price, October 2026'}).`
    );
    lines.push('An estimate: the service bills the exact amount.');
  } else lines.push('No price is known for this model: set one in the key form to see the cost.');
  return lines.join('\n');
}
