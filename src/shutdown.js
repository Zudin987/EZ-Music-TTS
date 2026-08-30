export function createShutdownCoordinator(cleanup) {
  if (typeof cleanup !== 'function') throw new TypeError('Shutdown coordinator requires a cleanup function.');
  let activePromise = null;

  return {
    run(signal) {
      if (!activePromise) activePromise = Promise.resolve().then(() => cleanup(signal));
      return activePromise;
    },
    isRunning() {
      return activePromise !== null;
    },
  };
}
