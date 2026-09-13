/**
 * @description Pure decision + codec layer behind the two-level `/model`
 * picker (providers → that provider's models, paginated).
 *
 * Why it exists: the old `/model` rendered EVERY model id into one Telegram
 * message. Once the operator's OpenCode gained the `openrouter` provider (367
 * models) that message grew to ~13 000 chars and every `/model` died on
 * Telegram's 4096-char cap ("message is too long") — the topic just went
 * silent. Buttons carry the list now; the message text stays short.
 *
 * Everything here is pure so `bot.ts` stays wiring: grouping, the
 * visible/hidden split, and the callback-id codec are unit-tested without a
 * Telegram surface.
 */

/**
 * @description Telegram's hard limit on `callback_data` (bytes, not chars).
 * Model ids like `openrouter/anthropic/claude-sonnet-4.5` blow past it, which
 * is why every picker callback carries INDEXES instead of names — the same
 * trick the `connm_<idx>` / `resume_<idx>` callbacks already use.
 */
export const telegramCallbackDataMaxBytes = 64;

const providerPageCallbackPrefix = 'mdlp_';
const modelPickCallbackPrefix = 'mdl_';
const providerHideCallbackPrefix = 'mdlhide_';
const providerShowCallbackPrefix = 'mdlshow_';

/** Back to the provider level (level 2 → level 1). */
export const modelPickerBackCallback = 'mdlback';
/** Inert label buttons (the "2/5" page pill, the hidden-provider name). */
export const modelPickerNoopCallback = 'mdlnoop';

/** Anchored matchers for `bot.action(...)`, kept beside the builders so the
 *  wire format has a single definition. */
export const providerPageCallbackRe = /^mdlp_(\d+)_(\d+)$/;
export const modelPickCallbackRe = /^mdl_(\d+)_(\d+)$/;
export const providerHideCallbackRe = /^mdlhide_(\d+)$/;
export const providerShowCallbackRe = /^mdlshow_(\d+)$/;

/** A provider index paired with a page index (level-2 navigation). */
export interface ProviderPageRef {
  providerIndex: number;
  page: number;
}

/** A provider index paired with a model index WITHIN that provider's list. */
export interface ModelPickRef {
  providerIndex: number;
  modelIndex: number;
}

export function buildProviderPageCallback(providerIndex: number, page: number): string {
  return `${providerPageCallbackPrefix}${providerIndex}_${page}`;
}

export function buildModelPickCallback(providerIndex: number, modelIndex: number): string {
  return `${modelPickCallbackPrefix}${providerIndex}_${modelIndex}`;
}

export function buildProviderHideCallback(providerIndex: number): string {
  return `${providerHideCallbackPrefix}${providerIndex}`;
}

export function buildProviderShowCallback(providerIndex: number): string {
  return `${providerShowCallbackPrefix}${providerIndex}`;
}

export function parseProviderPageCallback(callbackData: string): ProviderPageRef | null {
  const match = providerPageCallbackRe.exec(callbackData);
  if (!match) return null;
  return { providerIndex: Number(match[1]), page: Number(match[2]) };
}

export function parseModelPickCallback(callbackData: string): ModelPickRef | null {
  const match = modelPickCallbackRe.exec(callbackData);
  if (!match) return null;
  return { providerIndex: Number(match[1]), modelIndex: Number(match[2]) };
}

export function parseProviderHideCallback(callbackData: string): number | null {
  const match = providerHideCallbackRe.exec(callbackData);
  return match ? Number(match[1]) : null;
}

export function parseProviderShowCallback(callbackData: string): number | null {
  const match = providerShowCallbackRe.exec(callbackData);
  return match ? Number(match[1]) : null;
}

/** Whether a callback id fits Telegram's 64-BYTE `callback_data` budget. */
export function checkIsCallbackDataWithinLimit(callbackData: string): boolean {
  return Buffer.byteLength(callbackData, 'utf8') <= telegramCallbackDataMaxBytes;
}

/**
 * @description Group model ids by the provider segment before the first `/`.
 *
 * Ids WITHOUT a `/` land under `fallbackProvider` — the Claude backends report
 * bare aliases (`sonnet`, `opus`, `haiku`), and the old slash-only grouping
 * dropped them entirely, so `/model` on a Claude topic printed a header and an
 * EMPTY list. The fallback is the adapter's own label.
 *
 * Insertion order is preserved for both providers and their models so the
 * indexes the callback ids carry stay stable for a given catalog.
 */
export function groupModelsByProvider(
  models: readonly string[],
  fallbackProvider: string,
): Map<string, string[]> {
  const byProvider = new Map<string, string[]>();
  for (const model of models) {
    const slashIndex = model.indexOf('/');
    const provider = slashIndex > 0 ? model.slice(0, slashIndex) : fallbackProvider;
    const providerModels = byProvider.get(provider);
    if (providerModels) providerModels.push(model);
    else byProvider.set(provider, [model]);
  }
  return byProvider;
}

/**
 * @description Label a model carries inside its provider's page — the id with
 * the redundant `<provider>/` prefix stripped. A slash-less id (Claude alias
 * grouped under the adapter label) is shown whole.
 */
export function getModelShortLabel(modelId: string, provider: string): string {
  const prefix = `${provider}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/**
 * @description Whether the picker needs its provider level at all.
 *
 * A catalog with a single offered provider and nothing hidden (the Claude
 * backends: one fallback group of aliases) would make level 1 a one-button
 * detour, so the picker opens straight on that provider's models. As soon as
 * something is hidden the level is needed again — the unhide buttons live
 * there and are otherwise unreachable.
 */
export function checkHasProviderLevel(
  visibleProviderCount: number,
  hiddenProviderCount: number,
): boolean {
  return visibleProviderCount > 1 || hiddenProviderCount > 0;
}

/**
 * @description A model catalog split the way the picker consumes it: grouped by
 * provider, plus the offered/hidden partition.
 */
export interface ModelCatalog {
  /** Provider → its model ids, catalog order. */
  byProvider: Map<string, string[]>;
  /** Every provider in catalog order — the index space the callbacks carry. */
  providers: string[];
  visibleProviders: string[];
  hiddenProviders: string[];
}

/**
 * @description Assemble the picker's catalog from a raw model list. Pure — the
 * bot's `getModelCatalog` only adds the adapter fetch and the persisted
 * hidden-provider read around it.
 */
export function buildModelCatalog(
  models: readonly string[],
  fallbackProvider: string,
  hiddenProviders: readonly string[],
): ModelCatalog {
  const byProvider = groupModelsByProvider(models, fallbackProvider);
  const providers = [...byProvider.keys()];
  const { visible, hidden } = getProviderVisibility(providers, hiddenProviders);
  return { byProvider, providers, visibleProviders: visible, hiddenProviders: hidden };
}

export interface ProviderVisibility {
  /** Providers offered in the picker, in catalog order. */
  visible: string[];
  /** Providers the operator hid, in catalog order. */
  hidden: string[];
}

/**
 * @description Split the catalog's providers into offered vs hidden.
 *
 * Hiding is bot-side and GLOBAL (persisted in `state.json`): it is the only
 * lever that works for providers OpenCode enables from an environment variable
 * (`openrouter` ← `OPENROUTER_API_KEY`), which `DELETE /auth/:id` cannot remove.
 * A hidden provider is omitted from the pick list only — an explicit
 * `/model <provider/model>` still resolves it, so hiding never breaks a saved
 * model pref.
 *
 * Hidden entries no longer present in the catalog are ignored rather than
 * reported: a stale name from a disconnected provider must not render a
 * button that resolves to nothing.
 */
export function getProviderVisibility(
  allProviders: readonly string[],
  hiddenProviders: readonly string[],
): ProviderVisibility {
  const hiddenSet = new Set(hiddenProviders);
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const provider of allProviders) {
    if (hiddenSet.has(provider)) hidden.push(provider);
    else visible.push(provider);
  }
  return { visible, hidden };
}
