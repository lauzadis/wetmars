/**
 * Fetches and decodes tile images with a concurrency cap.
 *
 * Callers `touch()` every tile they still want on every frame; requests that haven't been
 * touched for `graceMs` are cancelled (in flight) or dropped (queued), so fast camera moves
 * don't leave a backlog of tiles nobody looks at any more.
 */
export class TileLoader {
    constructor({ onLoad, onError, onCancel }, { maxConcurrent = 8, graceMs = 500 } = {}) {
        this.onLoad = onLoad;       // (key, ImageBitmap)
        this.onError = onError;     // (key, httpStatus | 0 for network errors)
        this.onCancel = onCancel;   // (key)
        this.maxConcurrent = maxConcurrent;
        this.graceMs = graceMs;
        this.entries = new Map();
        this.now = 0;
    }

    get loading() {
        let n = 0;
        for (const e of this.entries.values()) if (e.controller) n++;
        return n;
    }

    get queued() {
        return this.entries.size - this.loading;
    }

    touch(key, url, priority) {
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { key, url, controller: null };
            this.entries.set(key, entry);
        }
        entry.priority = priority;
        entry.touched = this.now;
    }

    /** Call once per frame after all touch() calls. */
    update(now) {
        this.now = now;
        let loading = 0;
        const waiting = [];
        for (const entry of this.entries.values()) {
            if (now - entry.touched > this.graceMs) {
                entry.controller?.abort();
                this.entries.delete(entry.key);
                this.onCancel(entry.key);
            } else if (entry.controller) {
                loading++;
            } else {
                waiting.push(entry);
            }
        }
        waiting.sort((a, b) => a.priority - b.priority);
        for (const entry of waiting) {
            if (loading >= this.maxConcurrent) break;
            this.start(entry);
            loading++;
        }
    }

    async start(entry) {
        entry.controller = new AbortController();
        try {
            const res = await fetch(entry.url, { signal: entry.controller.signal });
            if (!res.ok) {
                const error = new Error(`HTTP ${res.status}`);
                error.status = res.status;
                throw error;
            }
            const bitmap = await createImageBitmap(await res.blob());
            if (this.entries.get(entry.key) !== entry) {
                bitmap.close();
                return;
            }
            this.entries.delete(entry.key);
            this.onLoad(entry.key, bitmap);
        } catch (error) {
            if (this.entries.get(entry.key) !== entry) return; // cancelled
            this.entries.delete(entry.key);
            this.onError(entry.key, error.status ?? 0);
        }
    }
}
