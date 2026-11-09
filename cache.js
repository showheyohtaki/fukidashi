export async function voiceKey(cfg, text) {
  const data = new TextEncoder().encode(
    JSON.stringify([cfg.voiceModel, cfg.voice, cfg.style, text]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export class VoiceCache {
  constructor() {
    this.memory = new Map();
    this.db = null;
  }
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("koe-bridge-v1", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("voices");
        r.result.createObjectStore("logs", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await this.expire();
    return this.db;
  }
  async request(store, mode, fn) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      let value;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("保存が中断されました"));
    });
  }
  async get(key) {
    return (
      this.memory.get(key) ||
      (await this.request("voices", "readonly", (s) => s.get(key)))
    );
  }
  async put(key, value, persistent = false) {
    if (persistent)
      await this.request("voices", "readwrite", (s) => s.put(value, key));
    else {
      this.memory.set(key, value);
      if (this.memory.size > 20)
        this.memory.delete(this.memory.keys().next().value);
    }
  }
  // 今の作り置きに含まれない、端末に残った古い声を消す（書き換えた項目の旧版など）。
  async prune(keep) {
    const keys = await this.request("voices", "readonly", (s) =>
      s.getAllKeys(),
    );
    const stale = (keys || []).filter((k) => !keep.has(k));
    if (!stale.length) return 0;
    await this.request("voices", "readwrite", (s) => {
      let last;
      for (const k of stale) last = s.delete(k);
      return last;
    });
    return stale.length;
  }
  clearCandidates() {
    this.memory.clear();
  }
  async clearVoices() {
    this.memory.clear();
    await this.request("voices", "readwrite", (s) => s.clear());
  }
  async clearLogs() {
    await this.request("logs", "readwrite", (s) => s.clear());
  }
  async saveLog(log) {
    await this.request("logs", "readwrite", (s) =>
      s.put({ ...log, expiresAt: Date.now() + 7 * 86400000 }),
    );
  }
  async listLogs() {
    await this.expire();
    return this.request("logs", "readonly", (s) => s.getAll());
  }
  async expire() {
    const db = this.db;
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction("logs", "readwrite");
      const req = tx.objectStore("logs").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          if (c.value.expiresAt <= Date.now()) c.delete();
          c.continue();
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}
