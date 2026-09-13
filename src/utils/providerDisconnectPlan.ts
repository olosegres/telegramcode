/**
 * @description Pure decision layer behind `/disconnect`: what did deleting a
 * provider's stored credentials actually achieve?
 *
 * `DELETE /auth/:id` only removes what OpenCode keeps in its own auth store. A
 * provider it enables from an ENVIRONMENT VARIABLE (`openrouter` ←
 * `OPENROUTER_API_KEY`) stays fully active afterwards — reporting "disconnected"
 * there would be a lie, and it is exactly the case that motivated the
 * bot-side "hide provider" toggle in `/model`. So the adapter re-reads the live
 * provider config after the delete and asks this helper what to tell the user.
 */

/**
 * @name ProviderDisconnectOutcome
 * @description
 * - `removed` — the provider is gone from the live catalog: a clean disconnect.
 * - `stillActiveViaEnv` — credentials were removed but the provider is still
 *   listed, i.e. it comes from an environment variable the bot cannot unset.
 */
export type ProviderDisconnectOutcome = 'removed' | 'stillActiveViaEnv';

const disconnectProviderCallbackPrefix = 'dscp_';

/** Anchored matcher for `bot.action(...)`, kept beside the builder so the wire
 *  format has one definition. */
export const disconnectProviderCallbackRe = /^dscp_(\d+)$/;

/**
 * @description Callback id for one row of the bare-`/disconnect` provider
 * picker. Index-based like `connm_<idx>` / `resume_<idx>`: Telegram caps
 * `callback_data` at 64 bytes, so the tapped entry is resolved against the
 * per-thread snapshot the picker stored rather than carried by name.
 */
export function buildDisconnectProviderCallback(providerIndex: number): string {
  return `${disconnectProviderCallbackPrefix}${providerIndex}`;
}

export function parseDisconnectProviderCallback(callbackData: string): number | null {
  const match = disconnectProviderCallbackRe.exec(callbackData);
  return match ? Number(match[1]) : null;
}

/**
 * @description How many picker snapshots the bot keeps before evicting the
 * oldest. Each is a handful of short provider ids, and an operator realistically
 * opens a couple of pickers — the cap only exists so a long-lived process can
 * never accumulate them without bound.
 */
export const disconnectPickerSnapshotLimit = 50;

/**
 * @description Snapshot key for ONE picker message.
 *
 * Keying by thread alone is a destructive bug: a second `/disconnect`
 * overwrites the thread's snapshot while the FIRST picker's buttons stay
 * tappable forever, so tapping "openai" (index 1) on the old message resolves
 * index 1 against the NEW list and deletes a different provider's credentials.
 * The message id makes each keyboard resolve only against the list it was
 * rendered from.
 */
export function buildDisconnectPickerKey(threadKeyString: string, messageId: number): string {
  return `${threadKeyString}:${messageId}`;
}

/**
 * @description Every snapshot key belonging to `threadKeyString` — the thread
 * teardown sweep, which must drop ALL of a thread's picker snapshots, not just
 * one.
 *
 * The trailing-digits check is load-bearing: a bare `startsWith` on the thread
 * key would make thread `-100:1` claim thread `-100:12`'s snapshots
 * (`"-100:12:5".startsWith("-100:1")` is true), wiping a live sibling topic's
 * picker.
 */
export function getDisconnectPickerKeysForThread(
  pickerKeys: Iterable<string>,
  threadKeyString: string,
): string[] {
  const prefix = `${threadKeyString}:`;
  return [...pickerKeys].filter(
    (pickerKey) => pickerKey.startsWith(prefix) && /^\d+$/.test(pickerKey.slice(prefix.length)),
  );
}

/**
 * @description Keys to evict so the snapshot store stays bounded — the oldest
 * first (`Map` preserves insertion order), keeping at most `limit` entries.
 */
export function getEvictedDisconnectPickerKeys(
  pickerKeys: Iterable<string>,
  limit: number = disconnectPickerSnapshotLimit,
): string[] {
  const keys = [...pickerKeys];
  return keys.length <= limit ? [] : keys.slice(0, keys.length - limit);
}

/**
 * @description Resolve a tapped `dscp_<idx>` button against the snapshot of the
 * message it sits on.
 *
 * Returns `null` — never another message's provider — when the tap carries no
 * message id, when that message's snapshot is gone (an old picker after a
 * restart or an eviction), or when the index is out of range. The caller turns
 * `null` into the "this menu expired" toast.
 */
export function getDisconnectPickerProviderAt(
  snapshots: ReadonlyMap<string, readonly string[]>,
  threadKeyString: string,
  messageId: number | null,
  index: number,
): string | null {
  if (messageId === null || !Number.isInteger(index) || index < 0) return null;
  const providers = snapshots.get(buildDisconnectPickerKey(threadKeyString, messageId));
  return providers?.[index] ?? null;
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

/**
 * @description Classify a finished disconnect from the provider ids still
 * active after the delete. Comparison is trim+lowercase so a differently-cased
 * catalog entry is never mistaken for a removed provider (which would report a
 * clean disconnect for a provider that is still serving models).
 */
export function getProviderDisconnectOutcome(
  providerId: string,
  activeProviderIdsAfterDelete: readonly string[],
): ProviderDisconnectOutcome {
  const target = normalizeProviderId(providerId);
  const isStillActive = activeProviderIdsAfterDelete.some(
    (activeProviderId) => normalizeProviderId(activeProviderId) === target,
  );
  return isStillActive ? 'stillActiveViaEnv' : 'removed';
}
