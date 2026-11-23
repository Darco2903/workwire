export function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

/** Call `onAbort` when any of `signals` aborts. Returns a cleanup function. */
export function watchSignals(signals: readonly AbortSignal[], onAbort: (reason: unknown) => void): () => void {
  if (!signals.length) return () => {};
  const listener = (event: Event) => onAbort((event.target as AbortSignal).reason);
  for (const signal of signals) signal.addEventListener('abort', listener, { once: true });
  return () => {
    for (const signal of signals) signal.removeEventListener('abort', listener);
  };
}
