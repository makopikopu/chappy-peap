// Drop-in replacement for the Claude-artifact `window.storage` API, backed by
// the browser's own localStorage. Same async shape (get/set take a `shared`
// flag as the 2nd/3rd arg) so the rest of the app doesn't need to change.
// `shared` is accepted for signature-compatibility but ignored here — there's
// no multi-user backend in this standalone build, everything is local to the
// browser it's opened in.

const PREFIX = "perp-tracker::";

function delay() {
  // keeps the same "it's async" shape as the real API, avoids accidental
  // sync-assumption bugs if anyone ever swaps this back out
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export const storage = {
  async get(key /*, shared */) {
    await delay();
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      if (raw === null) return null;
      return { key, value: raw };
    } catch (e) {
      console.error("storage.get failed", e);
      return null;
    }
  },

  async set(key, value /*, shared */) {
    await delay();
    try {
      window.localStorage.setItem(PREFIX + key, value);
      return { key, value };
    } catch (e) {
      console.error("storage.set failed", e);
      return null;
    }
  },

  async delete(key /*, shared */) {
    await delay();
    try {
      window.localStorage.removeItem(PREFIX + key);
      return { key, deleted: true };
    } catch (e) {
      console.error("storage.delete failed", e);
      return null;
    }
  },

  async list(prefix = "" /*, shared */) {
    await delay();
    try {
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
      }
      return { keys, prefix };
    } catch (e) {
      console.error("storage.list failed", e);
      return null;
    }
  },
};
