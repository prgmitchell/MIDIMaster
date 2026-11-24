// Profile preferences, binding edits, and MIDI reconciliation share the active profile.
export function createProfileWriteQueue() {
  let tail = Promise.resolve();
  let active = null;
  return {
    run(operation) {
      const result = tail.then(operation);
      active = result;
      tail = result
        .catch(() => {})
        .then(() => {
          if (active === result) active = null;
        });
      return result;
    },
    flush() {
      return active || tail;
    },
  };
}
