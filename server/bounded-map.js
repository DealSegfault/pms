/**
 * BoundedMap — Map with automatic eviction of oldest entries.
 *
 * Drop-in replacement for Map that prevents unbounded growth.
 * When maxSize is exceeded, the oldest entry (first inserted) is evicted.
 *
 * Usage:
 *   import { BoundedMap } from './bounded-map.js';
 *   const cache = new BoundedMap(1000);
 */
export class BoundedMap extends Map {
    constructor(maxSize = 10000) {
        super();
        this._maxSize = maxSize;
    }

    set(key, value) {
        // If key already exists, just update (no growth)
        if (this.has(key)) return super.set(key, value);

        // Evict oldest if at capacity
        if (this.size >= this._maxSize) {
            const firstKey = this.keys().next().value;
            this.delete(firstKey);
        }
        return super.set(key, value);
    }
}
