/** An AbortSignal that fires on SIGINT/SIGTERM while fn runs; the handlers are removed afterwards. */
export async function untilInterrupted<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await fn(controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
