/** Own persistent UI listeners so mounting and disposal remain symmetrical. */
export function createUiLifetime() {
  const cleanup = [];
  let disposed = false;
  return {
    listen(target, event, handler, options) {
      if (disposed || !target?.addEventListener) return;
      target.addEventListener(event, handler, options);
      cleanup.push(() => target.removeEventListener?.(event, handler, options));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup
        .splice(0)
        .reverse()
        .forEach((remove) => remove());
    },
  };
}
