/** Return the signal's Error reason, including a stable fallback for non-Error reasons. */
export function getAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * @description Whether a caught error is the abort raised for a cancelled
 * operation. Matches on the error IDENTITY (`name`), never on its message text.
 *
 * Covers every abort this codebase can raise: a bare `controller.abort()` puts a
 * DOMException named `AbortError` on `signal.reason`, and an abort carrying a
 * custom reason (the MCP cancellation notification passes a string) is surfaced
 * by {@link getAbortError} as a fresh `Error` with the same name.
 */
export function checkIsAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Sleep for the requested duration, rejecting promptly when the caller aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(getAbortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      clearTimeout(timer);
      if (signal) reject(getAbortError(signal));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

/**
 * @description Strip the `@botusername` Telegram appends to a slash command in
 * a group/supergroup.
 *
 * In groups, the Telegram client turns `/context` into
 * `/context@my_bot` (always, when the command is in the bot's command menu;
 * also whenever multiple bots are present). We forward un-owned slash commands
 * verbatim to the agent's CLI, which does NOT recognise the `@my_bot` suffix —
 * so `/context` silently no-ops. Strip the mention from the FIRST token only,
 * preserving any arguments: `/context@my_bot keep notes` → `/context keep notes`.
 *
 * Only touches a leading `/command@mention`; ordinary text and mid-text `@`s
 * (e.g. `email me @ foo`) are left untouched. Pure + exported for unit tests.
 */
export function stripCommandBotMention(text: string): string {
  return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, '$1');
}
