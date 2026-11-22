// One-at-a-time queue for file mutations, so concurrent write/edit calls can't lose each other's changes.

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously queued mutation has finished, one at a time. */
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
