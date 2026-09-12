import { splitMessage } from '../messageSplit';
import type { SendFilesToThread } from './fileSendService';

/**
 * @description Deliver a batch of DISCRETE messages into a topic. Unlike the
 * normal agent-output path (which coalesces / glues a burst into the fewest
 * messages), this sends each input item as its OWN Telegram message — the
 * primitive behind the `send_messages_to_user` MCP tool, used when an agent
 * wants several separate messages (e.g. a per-item news digest: one message per
 * headline). A single input string that renders past Telegram's cap is split
 * defensively, but two distinct inputs are NEVER merged.
 *
 * Each item may ALSO carry ONE attachment: an item with a `path` is delivered
 * through the SAME secure file-send pipeline as `send_file_to_user` (its `text`
 * becomes the media caption, trimmed to Telegram's 1024-char cap), reusing all
 * of that pipeline's path-safety, media classification, and dispatch. An item
 * without a `path` is a plain text message exactly as before.
 *
 * Kept dependency-free of `bot.ts` (which builds a Telegraf instance at module
 * load): the caller injects the target resolver, the per-chunk sender, and the
 * reusable file-send closure, so this service composes with the same paced send
 * path the rest of the bot uses and stays unit-testable in isolation (mirrors
 * `createSendFilesToThread`).
 */

/**
 * @name DiscreteMessageItem
 * @description One item of a `send_messages_to_user` batch. A plain string is a
 * text-only message (backward-compatible). An object may carry a text body, an
 * attachment `path` (relative to the bound folder), or both; `asFile` forces the
 * document override on the attachment. At least one of `text`/`path` must be
 * non-empty on an object item.
 */
export type DiscreteMessageItem =
  | string
  | { text?: string; path?: string; asFile?: boolean };

export type SendMessagesToThreadResult =
  | { ok: true; summary: string }
  | { ok: false; error: string }
  | { ok: false; kind: 'deliveryUnknown'; error: string };

export type SendMessagesToThread = (
  threadKey: string,
  args: SendMessagesToThreadOptions,
) => Promise<SendMessagesToThreadResult>;

export interface SendMessagesToThreadOptions {
  /** The items to deliver, in order; each becomes its own Telegram message. */
  messages: DiscreteMessageItem[];
  /**
   * Canonical directory granted by a directory-scoped MCP token. Threaded into
   * every attachment send so the file pipeline re-checks the binding, exactly
   * like `send_file_to_user`.
   */
  authorizedWorkDir?: string;
  /** Optional cancellation — checked between items (best-effort, coarse). */
  signal?: AbortSignal;
}

/**
 * Upper bound on how many discrete messages one call may deliver. A per-item
 * news digest is ~30–40 messages; 50 leaves headroom while bounding a runaway
 * call (each message is separately rate-paced, so a large batch also floods the
 * topic with notifications).
 */
export const maxDiscreteMessages = 50;

export interface SendMessagesToThreadDeps<TTarget> {
  /** Map the scope-resolved thread key string to the concrete send target. */
  resolveTarget(threadKey: string): { ok: true; target: TTarget } | { ok: false; error: string };
  /**
   * Send ONE already-split chunk as its own permanent message; resolves `true`
   * when it landed. The caller wires this to the bot's paced HTML-with-plain
   * -fallback send so ordering / rate-limiting / `/clear` tracking are reused.
   */
  sendChunk(target: TTarget, chunk: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Deliver ONE attachment via the SAME reusable file-send pipeline behind
   * `send_file_to_user` (path-safety, media classification, album/size rules,
   * 1024-char caption trim all reused). The caller injects the exact
   * `sendFilesToThread` closure it already built for the file tool.
   */
  sendFiles: SendFilesToThread;
  /** Max SOURCE length per message handed to {@link splitMessage} (defensive split). */
  maxMessageLength: number;
  /** Rendered-length measure so an over-cap RENDERED message is split like normal output. */
  measureRendered(chunk: string): number;
}

/**
 * @name NormalizedMessageItem
 * @description A validated batch item, already classified as a text send, an
 * attachment send, a skip (blank text), or a fatal validation error.
 */
type NormalizedMessageItem =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; caption?: string; asFile?: boolean }
  | { kind: 'skip' }
  | { kind: 'invalid'; error: string };

/** A validated item ready to deliver — {@link NormalizedMessageItem} minus the fatal `invalid` case. */
type DeliverableMessageItem = Exclude<NormalizedMessageItem, { kind: 'invalid' }>;

/** Trim a value and report whether anything non-blank remains. */
function getNonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/**
 * @description Classify one raw batch item. A plain non-empty string is a text
 * message; a blank string is skipped (a stray separator never posts an empty
 * bubble). An object with a non-blank `path` is an attachment send (its `text`
 * becomes the caption when non-blank); an object with only text is a text
 * message; an object with neither is a fatal validation error (the agent sent
 * an empty item).
 */
function normalizeDiscreteMessageItem(item: DiscreteMessageItem): NormalizedMessageItem {
  if (typeof item === 'string') {
    return item.trim().length === 0 ? { kind: 'skip' } : { kind: 'text', text: item };
  }
  const path = getNonBlank(item.path);
  const text = getNonBlank(item.text);
  if (path !== undefined) {
    return {
      kind: 'file',
      path,
      ...(text !== undefined ? { caption: text } : {}),
      ...(item.asFile !== undefined ? { asFile: item.asFile } : {}),
    };
  }
  if (text !== undefined) return { kind: 'text', text };
  return { kind: 'invalid', error: 'each message item must have a non-empty text or path' };
}

/** Pluralised "N message(s)" for the human summary. */
function formatMessageCount(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}

/**
 * @description Build the discrete-message sender. Each item is delivered as its
 * OWN message, preserving order: a text item is split (defensively) into
 * Telegram-sized chunks and each chunk sent separately; an attachment item goes
 * through the injected file-send pipeline as a single path (text → caption).
 * Cancellation is checked between items (coarse — a chunk already dispatched to
 * the pacer still lands).
 *
 * Items are validated up front (an all-empty object → error, nothing sent) so
 * the service mirrors the MCP schema's all-or-nothing rejection. Failure is NOT
 * swallowed: if every send failed the result is an ERROR (with any attachment
 * errors named), so the agent knows nothing reached the topic instead of reading
 * a false "Delivered 0" success; a partial failure stays `ok` but says how many
 * landed. An attachment whose delivery outcome is unknown terminates the batch
 * with a `deliveryUnknown` result so the agent does not blindly retry (mirrors
 * `send_file_to_user`).
 */
export function createSendMessagesToThread<TTarget>(
  deps: SendMessagesToThreadDeps<TTarget>,
): SendMessagesToThread {
  return async (threadKey, { messages, authorizedWorkDir, signal }) => {
    const normalized: DeliverableMessageItem[] = [];
    for (const rawItem of messages) {
      const item = normalizeDiscreteMessageItem(rawItem);
      if (item.kind === 'invalid') return { ok: false, error: item.error };
      normalized.push(item);
    }

    const resolved = deps.resolveTarget(threadKey);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { target } = resolved;

    let attempted = 0;
    let landed = 0;
    const attachmentErrors: string[] = [];
    for (const item of normalized) {
      if (signal?.aborted) {
        return { ok: false, error: `cancelled after delivering ${formatMessageCount(landed)}` };
      }
      if (item.kind === 'skip') continue;

      if (item.kind === 'file') {
        attempted += 1;
        const fileResult = await deps.sendFiles(threadKey, {
          paths: [item.path],
          ...(item.caption !== undefined ? { caption: item.caption } : {}),
          ...(item.asFile !== undefined ? { asFile: item.asFile } : {}),
          ...(authorizedWorkDir !== undefined ? { authorizedWorkDir } : {}),
          signal,
        });
        if (fileResult.ok) {
          landed += 1;
        } else if ('kind' in fileResult && fileResult.kind === 'deliveryUnknown') {
          return {
            ok: false,
            kind: 'deliveryUnknown',
            error:
              `Delivered ${formatMessageCount(landed)} before an attachment's delivery ` +
              `outcome became unknown: ${fileResult.error}`,
          };
        } else {
          attachmentErrors.push(fileResult.error);
        }
        continue;
      }

      const chunks = splitMessage(item.text, deps.maxMessageLength, deps.measureRendered);
      for (const chunk of chunks) {
        attempted += 1;
        if (await deps.sendChunk(target, chunk, signal)) landed += 1;
      }
    }

    const attachmentErrorSuffix =
      attachmentErrors.length > 0 ? ` Attachment errors: ${attachmentErrors.join('; ')}.` : '';

    if (attempted > 0 && landed === 0) {
      return {
        ok: false,
        error:
          'Failed to deliver any message to the topic (Telegram rejected the sends).' +
          attachmentErrorSuffix,
      };
    }
    const summary =
      (landed === attempted
        ? `Delivered ${formatMessageCount(landed)} to the topic.`
        : `Delivered ${landed} of ${attempted} messages to the topic (${attempted - landed} failed to send).`) +
      attachmentErrorSuffix;
    return { ok: true, summary };
  };
}
