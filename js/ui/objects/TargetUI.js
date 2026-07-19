class TargetUI {
    constructor() {
        this.container = document.body;
        this.targetMap = new Map();
        this._maskMode = false;
        this._maskLoopActive = false;
        this.debugEnabled = false;

        // --- COLLIDER CANVAS (Hidden, for pixel-perfect physics) ---
        // This canvas receives the MJPEG mask for isHit() checks.
        this.colliderCanvas = document.createElement('canvas');
        this.colliderCanvas.width = 1920;
        this.colliderCanvas.height = 1080;
        this.cCtx = this.colliderCanvas.getContext('2d', { willReadFrequently: true });
        this.cCtx.imageSmoothingEnabled = false;

        // --- VISUAL CANVAS (For 'H' vision) ---
        // This canvas shows the colorful hitboxes/polygons.
        this.hitboxCanvas = document.createElement('canvas');
        this.hitboxCanvas.id = 'target-hitbox-canvas';
        this.hitboxCanvas.width = 1920;
        this.hitboxCanvas.height = 1080;
        this.hitboxCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;opacity:0;';
        this.container.appendChild(this.hitboxCanvas);
        this.ctx = this.hitboxCanvas.getContext('2d');

        this._maskImg = new Image();
        this._maskImg.id = 'target-mask-stream';
        this._maskImg.crossOrigin = 'anonymous';
        this._maskImg.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9998;opacity:0;image-rendering: pixelated; image-rendering: crisp-edges;';
        this.container.appendChild(this._maskImg);

        // Define global toggle for the 'H' key to show/hide the mask overlay
        window.toggleHitboxDebug = () => {
            this.debugEnabled = !this.debugEnabled;
            
            if (this._maskMode) {
                this.hitboxCanvas.style.opacity = '0';
                this._maskImg.style.opacity = this.debugEnabled ? '0.7' : '0';
            } else {
                this.hitboxCanvas.style.opacity = this.debugEnabled ? '0.7' : '0';
                this._maskImg.style.opacity = '0';
            }
        };

        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'h') {
                window.toggleHitboxDebug();
            }
        });
    }

    _getSyncID(targetName) {
        if (!window.configManager || !window.configManager.IN_MEMORY_CONFIG) return 1;
        const cfg = window.configManager.IN_MEMORY_CONFIG.camera_tracking || {};
        const targets = [];
        if (cfg.avatar_source) targets.push(cfg.avatar_source);
        if (cfg.secondary_sources) {
            cfg.secondary_sources.forEach(s => {
                if (s && !targets.includes(s)) targets.push(s);
            });
        }
        const idx = targets.indexOf(targetName);
        return idx === -1 ? 1 : (idx % 255) + 1;
    }

    _startMaskStream() {
        if (this._maskLoopActive) return;
        this._maskLoopActive = true;
        const urlParams = new URLSearchParams(window.location.search);
        let host = urlParams.get('host') || urlParams.get('ip') || window.location.hostname || '127.0.0.1';
        if (host === 'localhost') host = '127.0.0.1';
        const streamUrl = `http://${host}:41838/mask.mjpg?t=${Date.now()}`;
        this._maskImg.src = streamUrl;

        // If debug is on, show the mask image overlay
        if (this.debugEnabled) {
            this._maskImg.style.opacity = '0.7';
        }
        
        const drawLoop = () => {
            if (!this._maskLoopActive) return;
            if (this._maskImg.complete || this._maskImg.naturalWidth > 0) {
                try {
                    // Update ONLY the hidden collider canvas with the mask
                    this.cCtx.drawImage(this._maskImg, 0, 0, 1920, 1080);
                } catch (e) { }
            }
            requestAnimationFrame(drawLoop);
        };
        requestAnimationFrame(drawLoop);
    }

    _stopMaskStream() {
        this._maskLoopActive = false;
        this._maskImg.src = '';
        this._maskImg.style.opacity = '0'; // Hide mask overlay
        this.cCtx.clearRect(0, 0, 1920, 1080);
    }

    update(targetData) {
        const firstEntry = Object.values(targetData)[0];
        const pixelMode = firstEntry?.use_pixel === true;

        if (pixelMode !== this._maskMode) {
            this._maskMode = pixelMode;
            if (pixelMode) this._startMaskStream();
            else this._stopMaskStream();
        }

        // Always clear the visual canvas on every websocket update
        this.ctx.clearRect(0, 0, 1920, 1080);
        
        // If not in pixel mode, clear collider too (manual drawing will fill it)
        if (!pixelMode) {
            this.cCtx.clearRect(0, 0, 1920, 1080);
        }

        for (const [name, data] of Object.entries(targetData)) {
            const lowerName = name.toLowerCase();
            let t = this.targetMap.get(lowerName);
            const syncId = this._getSyncID(name);

            if (!t) {
                t = { 
                    id: syncId, 
                    originalName: name
                };
                this.targetMap.set(lowerName, t);
            }
            t.id = syncId;

            t.bounds = [...data.bounds];
            t.x = data.x;
            t.y = data.y;
            t.mass = data.mass;

            // --- DRAWING LOGIC ---
            // We draw colorful hitboxes for the user's "Vision" (H mode)
            if (!pixelMode) {
                const r = t.id;
                const g = (t.id * 80) % 256;
                const b = (t.id * 150) % 256;
                const color = `rgb(${r}, ${g}, ${b})`;
                
                this.ctx.fillStyle = color;
                if (data.use_polygon && data.polygon && data.polygon.length > 0) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(data.polygon[0][0], data.polygon[0][1]);
                    data.polygon.slice(1).forEach(p => this.ctx.lineTo(p[0], p[1]));
                    this.ctx.closePath();
                    this.ctx.fill();
                } else if (data.bounds) {
                    const [bx, by, bw, bh] = data.bounds;
                    this.ctx.fillRect(bx, by, bw, bh);
                }
            }

            // If we're NOT using the MJPEG mask, we also draw the collider shape manually
            if (!pixelMode) {
                let fillStyle = '#000000';
                const c = (t.id - 1) % 3;
                if (c === 0) fillStyle = 'rgb(255, 0, 0)';
                else if (c === 1) fillStyle = 'rgb(0, 255, 0)';
                else fillStyle = 'rgb(0, 0, 255)';
                this.cCtx.fillStyle = fillStyle;
                if (data.use_polygon && data.polygon && data.polygon.length > 0) {
                    this.cCtx.beginPath();
                    this.cCtx.moveTo(data.polygon[0][0], data.polygon[0][1]);
                    data.polygon.slice(1).forEach(p => this.cCtx.lineTo(p[0], p[1]));
                    this.cCtx.closePath();
                    this.cCtx.fill();
                } else if (data.use_box && data.bounds) {
                    const [bx, by, bw, bh] = data.bounds;
                    this.cCtx.fillRect(bx, by, bw, bh);
                }
            }
        }

        const activeNames = Object.keys(targetData).map(n => n.toLowerCase());
        for (const name of this.targetMap.keys()) {
            if (!activeNames.includes(name)) this.targetMap.delete(name);
        }
    }

    isHit(x, y, targetName) {
        if (!targetName) return false;
        const t = this.targetMap.get(targetName.toLowerCase());
        if (!t) return false;

        // Convert viewport/screen coordinates (x, y) to the internal 1920x1080 canvas coordinates
        const scaleX = 1920 / window.innerWidth;
        const scaleY = 1080 / window.innerHeight;
        const canvasX = x * scaleX;
        const canvasY = y * scaleY;

        const radius = 2;
        const ix = Math.floor(canvasX - radius);
        const iy = Math.floor(canvasY - radius);
        
        try {
            // physics always samples from the hidden collider canvas
            const imageData = this.cCtx.getImageData(ix, iy, radius * 2, radius * 2);
            const data = imageData.data;
            
            const c = (t.id - 1) % 3;
            const channelOffset = c; // 0 = Red, 1 = Green, 2 = Blue
            
            for (let i = 0; i < data.length; i += 4) {
                const val = data[i + channelOffset];
                // Saturated check (>= 128) eliminates any border anti-aliasing/noise leakage
                if (val >= 128) return true;
            }
        } catch (e) {
            return false;
        }
        return false;
    }

    getTargetBounds(name) {
        if (!name) return null;
        const t = this.targetMap.get(name.toLowerCase());
        if (!t || !t.bounds) return null;
        
        // Scale bounds from 1920x1080 space back to screen viewport space
        const scaleX = window.innerWidth / 1920;
        const scaleY = window.innerHeight / 1080;
        const [bx, by, bw, bh] = t.bounds;
        return [bx * scaleX, by * scaleY, bw * scaleX, bh * scaleY];
    }



    getTargetCenter(name) {
        if (!name) return null;
        const t = this.targetMap.get(name.toLowerCase());
        if (!t || t.x === undefined || t.y === undefined) return null;
        
        // Scale center from 1920x1080 space back to screen viewport space
        const scaleX = window.innerWidth / 1920;
        const scaleY = window.innerHeight / 1080;
        return { x: t.x * scaleX, y: t.y * scaleY };
    }
}

window.targetUI = new TargetUI();
window.targetUISync = (data) => window.targetUI.update(data);


