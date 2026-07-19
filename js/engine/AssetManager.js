/**
 * ARCHITECTURAL NOTE: Theatre Physics & Rendering (app.js)
 * 
 * 1. Scope: This file manages the main infinite RequestAnimationFrame loop for canvas rendering.
 * 2. Systems: It runs physics evaluations (gravity, friction) and collision detection for throwables.
 * 3. Fallbacks: Before the HTML DOM rendering overhaul, this script drew images directly to the `<canvas>`.
 *    Currently, most "Avatars" and "Reactions" are routed to the DOM (`theatre-systems.js`).
 * 4. Tracking & Debug: Handles continuous `TargetSystem.resolveTarget()` logic to lock on to DOM 
 *    hitboxes (`#camera-hitbox-target`) and calculates the parallax offsets broadcasted to `obs-bridge.js`.
 */

class AssetManager {
    constructor() {
        this.cache = new Map();
        this.loading = new Set();
        this.dynamicKeys = [];
    }

    /**
     * Internal helper to cache assets and automatically evict oldest dynamic assets
     * to prevent infinite memory growth (e.g. web captures, temporary throwables).
     */
    cacheAsset(id, data) {
        this.cache.set(id, data);
        if (id.startsWith('dynamic_img_')) {
            this.dynamicKeys.push(id);
            if (this.dynamicKeys.length > 30) {
                const oldestId = this.dynamicKeys.shift();
                this.cache.delete(oldestId);
            }
        }
    }

    /**
     * Loads an image, resizes it using an offscreen canvas to optimize rendering,
     * and stores it in the cache.
     */
    async load(id, url, targetHeight = 100) {
        if (this.cache.has(id) || this.loading.has(id)) return;
        this.loading.add(id);

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                // Calculate new dimensions maintaining aspect ratio
                const ratio = img.width / img.height;
                const targetWidth = targetHeight * ratio;

                // Create offscreen canvas for caching
                const offscreen = document.createElement('canvas');
                offscreen.width = targetWidth;
                offscreen.height = targetHeight;
                const ctx = offscreen.getContext('2d', { willReadFrequently: true });
                
                // Draw and scale down
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                // Store object with canvas and dimensions
                this.cacheAsset(id, {
                    canvas: offscreen,
                    width: targetWidth,
                    height: targetHeight,
                    halfWidth: targetWidth / 2,
                    halfHeight: targetHeight / 2
                });
                
                this.loading.delete(id);
                resolve();
            };
            img.onerror = (err) => {
                console.error(`Failed to load asset: ${url}`, err);
                this.loading.delete(id);
                reject(err);
            };
            img.src = url;
        });
    }

    /**
     * Loads and resizes a PNG or GIF (static frame only).
     * Returns a Promise that resolves when the asset is ready in the cache.
     * id: unique string for cache
     * url: image URL
     * targetHeight: desired height in px
     */
    async loadAndResizeStatic(id, url, targetHeight = 100) {
        if (this.cache.has(id) || this.loading.has(id)) return;
        this.loading.add(id);
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                const ratio = img.width / img.height;
                const targetWidth = targetHeight * ratio;
                const offscreen = document.createElement('canvas');
                offscreen.width = targetWidth;
                offscreen.height = targetHeight;
                const ctx = offscreen.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
                this.cacheAsset(id, {
                    canvas: offscreen,
                    width: targetWidth,
                    height: targetHeight,
                    halfWidth: targetWidth / 2,
                    halfHeight: targetHeight / 2,
                    type: 'static',
                    src: url
                });
                this.loading.delete(id);
                resolve();
            };
            img.onerror = (err) => {
                this.loading.delete(id);
                reject(err);
            };
            img.src = url;
        });
    }

    /**
     * Loads an animated GIF (no resizing offscreen, just loads as <img> but stores target dimensions).
     * id: unique string for cache
     * url: gif URL
     * targetHeight: desired height in px
     */
    async loadAnimatedGif(id, url, targetHeight = 100) {
        if (this.cache.has(id) || this.loading.has(id)) return;
        this.loading.add(id);
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                const ratio = img.width / img.height;
                const targetWidth = targetHeight * ratio;

                this.cacheAsset(id, {
                    img: img,
                    width: targetWidth,
                    height: targetHeight,
                    halfWidth: targetWidth / 2,
                    halfHeight: targetHeight / 2,
                    type: 'animated',
                    src: url
                });
                this.loading.delete(id);
                resolve();
            };
            img.onerror = (err) => {
                this.loading.delete(id);
                reject(err);
            };
            img.src = url;
        });
    }

    /**
     * Loads a static GIF (first frame only) for throwing objects, with file size check.
     * id: unique string for cache
     * url: gif URL
     * targetHeight: desired height in px
     * maxBytes: maximum allowed file size in bytes (default 1MB)
     */
    async loadStaticGifWithSizeLimit(id, url, targetHeight = 100, maxBytes = 1048576) {
        if (this.cache.has(id) || this.loading.has(id)) return;
        this.loading.add(id);
        // Fetch the file as a blob to check size
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            if (blob.size > maxBytes) {
                this.loading.delete(id);
                throw new Error('GIF file too large for throwing object (max ' + (maxBytes/1024) + ' KB)');
            }
            // Create an image from the blob
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "Anonymous";
                img.onload = () => {
                    const ratio = img.width / img.height;
                    const targetWidth = targetHeight * ratio;
                    const offscreen = document.createElement('canvas');
                    offscreen.width = targetWidth;
                    offscreen.height = targetHeight;
                    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
                    this.cacheAsset(id, {
                        canvas: offscreen,
                        width: targetWidth,
                        height: targetHeight,
                        halfWidth: targetWidth / 2,
                        halfHeight: targetHeight / 2,
                        type: 'static-gif',
                        src: url
                    });
                    this.loading.delete(id);
                    resolve();
                };
                img.onerror = (err) => {
                    this.loading.delete(id);
                    reject(err);
                };
                img.src = URL.createObjectURL(blob);
            });
        } catch (err) {
            this.loading.delete(id);
            throw err;
        }
    }

    get(id) {
        return this.cache.get(id);
    }
}

// Global instance
const assets = new AssetManager();

