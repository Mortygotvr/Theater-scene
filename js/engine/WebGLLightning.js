class ThreeLightningManager {
    static init() {
        console.log("[ThreeLightningManager] init() called. THREE status:", typeof THREE !== 'undefined' ? "defined" : "undefined");
        if (typeof THREE === 'undefined') {
            console.warn("[ThreeLightningManager] THREE is undefined. WebGL Lightning will use 2D fallback.");
            return;
        }
        if (this.initialized) {
            console.log("[ThreeLightningManager] Already initialized.");
            return;
        }

        try {
            this.width = window.innerWidth;
            this.height = window.innerHeight;

            this.canvas = document.createElement('canvas');
            this.canvas.id = 'three-lightning-canvas';
            this.canvas.width = this.width;
            this.canvas.height = this.height;
            this.canvas.style.position = 'absolute';
            this.canvas.style.top = '0';
            this.canvas.style.left = '0';
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.zIndex = '2';
            this.canvas.style.pointerEvents = 'none';
            document.body.appendChild(this.canvas);
            console.log(`[ThreeLightningManager] Created canvas and appended to DOM: ${this.width}x${this.height}`);

            this.renderer = new THREE.WebGLRenderer({
                canvas: this.canvas,
                alpha: true,
                antialias: true
            });
            this.renderer.setSize(this.width, this.height);
            this.renderer.setPixelRatio(1);
            this.renderer.setClearColor(0x000000, 0);
            console.log("[ThreeLightningManager] WebGLRenderer created.");

            this.scene = new THREE.Scene();

            // Camera bounds map to the full window size [0, window.innerWidth] and [0, window.innerHeight]
            // This allows us to use screen pixel coordinates inside the 3D scene directly.
            this.camera = new THREE.OrthographicCamera(0, window.innerWidth, window.innerHeight, 0, -1000, 1000);
            this.camera.position.set(0, 0, 100);
            console.log("[ThreeLightningManager] OrthographicCamera created.");

            this.selectedObjects = [];
            this.lastRenderTime = 0;
            this.lastDrawTime = 0;

            window.addEventListener('resize', () => this.resize());

            this.initialized = true;
            console.log("[ThreeLightningManager] Initialized successfully without outline post-processing.");
        } catch (e) {
            console.error("[ThreeLightningManager] Error during initialization:", e);
            this.initialized = false;
        }
    }

    static resize() {
        if (!this.initialized) return;
        this.width = window.innerWidth;
        this.height = window.innerHeight;

        this.canvas.width = this.width;
        this.canvas.height = this.height;

        this.renderer.setSize(this.width, this.height);

        this.camera.left = 0;
        this.camera.right = window.innerWidth;
        this.camera.top = window.innerHeight;
        this.camera.bottom = 0;
        this.camera.updateProjectionMatrix();
    }

    static addMesh(mesh) {
        this.init();
        if (!this.initialized) return;
        this.scene.add(mesh);
        this.selectedObjects.push(mesh);
    }

    static removeMesh(mesh) {
        if (!this.initialized) return;
        this.scene.remove(mesh);
        const idx = this.selectedObjects.indexOf(mesh);
        if (idx !== -1) {
            this.selectedObjects.splice(idx, 1);
        }
    }

    static render() {
        if (!this.initialized) return;

        if (this.selectedObjects.length === 0) {
            this.renderer.clear();
            return;
        }

        try {
            this.renderer.clear();
            this.renderer.render(this.scene, this.camera);
        } catch (e) {
            console.error("[ThreeLightningManager] Error during render():", e);
        }
    }
}
window.ThreeLightningManager = ThreeLightningManager;

class WebGLLightning {
    constructor(startX, startY, config = {}) {
        this.startX = startX;
        this.startY = startY;

        this.colorR = config.colorR !== undefined ? parseFloat(config.colorR) : 180;
        this.colorG = config.colorG !== undefined ? parseFloat(config.colorG) : 220;
        this.colorB = config.colorB !== undefined ? parseFloat(config.colorB) : 255;
        this.colorA = config.colorA !== undefined ? parseFloat(config.colorA) : 1.0;
        this.colorHex = (Math.round(this.colorR) << 16) | (Math.round(this.colorG) << 8) | Math.round(this.colorB);

        this.strikeCount = config.strikeCount !== undefined ? parseInt(config.strikeCount) : 3;
        this.boltCount = config.boltCount !== undefined ? parseInt(config.boltCount) : 2;
        this.duration = config.duration !== undefined ? parseFloat(config.duration) : 500;
        this.boltWidth = config.boltWidth !== undefined ? parseFloat(config.boltWidth) : 4.0;

        // yomboprime parameters
        this.roughness = config.roughness !== undefined ? parseFloat(config.roughness) : 0.85;
        this.straightness = config.straightness !== undefined ? parseFloat(config.straightness) : 0.6;
        this.ramification = config.branching !== undefined ? parseInt(config.branching) : 3;

        this.speed = config.speed !== undefined ? parseFloat(config.speed) : 1.0;
        this.enableBloom = config.enableBloom !== undefined ? config.enableBloom !== false : true;
        this.maxIterations = config.maxIterations !== undefined ? parseInt(config.maxIterations) : 5;
        this.stopAtMask = config.stopAtMask !== undefined ? config.stopAtMask === true : false;

        this.bloomColorR = config.bloomColorR !== undefined ? parseFloat(config.bloomColorR) : this.colorR;
        this.bloomColorG = config.bloomColorG !== undefined ? parseFloat(config.bloomColorG) : this.colorG;
        this.bloomColorB = config.bloomColorB !== undefined ? parseFloat(config.bloomColorB) : this.colorB;
        this.bloomColorA = config.bloomColorA !== undefined ? parseFloat(config.bloomColorA) : this.colorA;
        this.bloomSize = config.bloomSize !== undefined ? parseFloat(config.bloomSize) : 1.0;

        this.targetName = config.targetName || 'avatar';
        this.targetOffsetX = config.targetOffsetX || 0;
        this.targetOffsetY = config.targetOffsetY || 0;
        this.targetWX = config.targetWX || (window.innerWidth / 2);
        this.targetWY = config.targetWY || (window.innerHeight / 2);

        this.dead = false;
        this.startTime = performance.now();
        
        // Force 2D canvas fallback path
        this.isFallback = true;
        this.generatedPaths = [];
        this.noiseSeed = Math.random();

        console.log(`[WebGLLightning] Constructed 2D planar lightning at (${this.startX}, ${this.startY}) targeting "${this.targetName}".`);
    }

    update() {
        if (this.dead) return;

        const elapsed = performance.now() - this.startTime;
        if (elapsed >= this.duration) {
            console.log(`[WebGLLightning] Lifetime completed (${elapsed}ms >= ${this.duration}ms). Setting dead=true.`);
            this.dead = true;
            this.destroy();
            return;
        }
    }

    generate2DLightning(x1, y1, x2, y2, time) {
        const paths = []; // Array of { points: [{x, y}, ...], width: number }
        const seed = this.noiseSeed || 0.5;

        const generatePath = (startX, startY, endX, endY, numSegments, iteration, widthFactor) => {
            const dx = endX - startX;
            const dy = endY - startY;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const segLen = dist / numSegments;

            const points = [];
            for (let k = 0; k <= numSegments; k++) {
                let t = k / numSegments;
                let px = startX + dx * t;
                let py = startY + dy * t;

                if (k > 0 && k < numSegments) {
                    // Let's compute a base envelope to keep start and end points locked
                    let envelope = Math.sin(t * Math.PI);

                    // Master displacement scale based on (1.0 - straightness) and the total distance
                    // If straightness is 1.0, the displacement is 0.0 (perfectly straight).
                    let maxStray = dist * (1.0 - this.straightness) * 0.25;

                    // 1. Low-frequency main wave (governed by straightness)
                    // We use t (normalized distance) for phase so frequency is constant and independent of segment count.
                    let mainNoise = Math.sin(t * Math.PI * 2.0 + time * 15.0 + seed * 100.0 + iteration * 5.0);
                    let mainDisp = mainNoise * maxStray * envelope;

                    // 2. High-frequency detail wiggles (governed by both straightness AND roughness)
                    // We use t for the phase so detail frequency does not increase with segment count.
                    // If roughness is 0, detailDisp is 0.
                    let detailDisp = 0;
                    let detailAmp = this.roughness * maxStray * 0.45;
                    let freq = 6.0 * Math.PI;

                    for (let octave = 0; octave < 3; octave++) {
                        let noiseVal = Math.sin(t * freq + time * (30.0 + octave * 10.0) + seed * (200.0 + octave * 70.0));
                        detailDisp += noiseVal * detailAmp * envelope;
                        detailAmp *= this.roughness * 0.5; // Scale down successive octaves
                        freq *= 2.0; // Increase frequency of successive octaves
                    }

                    // Perpendicular vector
                    let nx = -dy / dist;
                    let ny = dx / dist;

                    let finalDisp = mainDisp + detailDisp;
                    px += nx * finalDisp;
                    py += ny * finalDisp;
                }
                points.push({ x: px, y: py });
            }

            paths.push({ points: points, width: widthFactor });

            // Branching
            if (this.ramification > 0 && iteration < 2) {
                const step = Math.max(2, Math.floor(points.length / (this.ramification + 1)));
                for (let j = step; j < points.length - step; j += step) {
                    let branchNoise = Math.sin(j * 3.1 + time * 5.0 + seed * 50.0);
                    if (branchNoise > 0.1) {
                        let pStart = points[j];
                        let pNext = points[Math.min(points.length - 1, j + 1)];

                        let branchDx = pNext.x - pStart.x;
                        let branchDy = pNext.y - pStart.y;
                        let branchLen = Math.sqrt(branchDx * branchDx + branchDy * branchDy) || 1;

                        // Rotate branch direction
                        let angle = (Math.sin(j + time) > 0 ? 1 : -1) * (0.4 + Math.random() * 0.4);
                        let cos = Math.cos(angle);
                        let sin = Math.sin(angle);
                        let rotDx = (branchDx * cos - branchDy * sin) / branchLen;
                        let rotDy = (branchDx * sin + branchDy * cos) / branchLen;

                        // Branch length is a fraction of the remaining distance to target
                        let remainingDist = Math.sqrt((endX - pStart.x) * (endX - pStart.x) + (endY - pStart.y) * (endY - pStart.y));
                        let actualBranchLen = remainingDist * (0.3 + Math.random() * 0.3);

                        let pEnd = {
                            x: pStart.x + rotDx * actualBranchLen,
                            y: pStart.y + rotDy * actualBranchLen
                        };

                        // Generate branch path with fewer segments
                        generatePath(
                            pStart.x,
                            pStart.y,
                            pEnd.x,
                            pEnd.y,
                            Math.max(2, Math.floor(numSegments * 0.5)),
                            iteration + 1,
                            widthFactor * 0.5
                        );
                    }
                }
            }
        };

        generatePath(x1, y1, x2, y2, this.maxIterations, 0, 1.0);
        return paths;
    }

    draw(ctx) {
        if (this.dead) return;

        // Get target coordinates in sync with current render frame
        let targetX = this.targetWX;
        let targetY = this.targetWY;
        if (this.targetName && window.targetUI) {
            const center = window.targetUI.getTargetCenter(this.targetName);
            if (center) {
                targetX = center.x;
                targetY = center.y;
            }
        }
        targetX += this.targetOffsetX;
        targetY += this.targetOffsetY;

        if (this.stopAtMask && this.targetName && window.targetUI) {
            const intersection = this.findMaskIntersection(this.startX, this.startY, targetX, targetY, this.targetName);
            targetX = intersection.x;
            targetY = intersection.y;
        }

        const elapsed = performance.now() - this.startTime;
        const flashElapsed = elapsed / 1000;

        // Generate paths dynamically every frame
        this.generatedPaths = [];
        for (let b = 0; b < this.boltCount; b++) {
            // Distribute seed/offset for multiple simultaneous bolts
            const paths = this.generate2DLightning(
                this.startX,
                this.startY,
                targetX,
                targetY,
                (flashElapsed * this.speed) + (b * 12.3)
            );
            this.generatedPaths.push(...paths);
        }

        if (!this.generatedPaths.length) return;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Draw base/glow passes
        if (this.enableBloom) {
            // Draw multi-pass glow using hardware-accelerated CSS filter blur in 2D canvas
            const passes = [
                { blurRadius: 16 * this.bloomSize, widthMult: 5.0, alphaMult: 0.20 },
                { blurRadius: 7 * this.bloomSize,  widthMult: 2.8, alphaMult: 0.40 },
                { blurRadius: 2.2 * this.bloomSize, widthMult: 1.4, alphaMult: 0.70 }
            ];

            for (const pass of passes) {
                ctx.save();
                if (pass.blurRadius > 0 && typeof ctx.filter !== 'undefined') {
                    ctx.filter = `blur(${pass.blurRadius}px)`;
                }
                for (let pIdx = 0; pIdx < this.generatedPaths.length; pIdx++) {
                    const pathObj = this.generatedPaths[pIdx];
                    const path = pathObj.points;
                    const pathWidth = this.boltWidth * pathObj.width * pass.widthMult;
                    const pathAlpha = this.bloomColorA * pass.alphaMult;
                    
                    ctx.lineWidth = pathWidth;
                    ctx.strokeStyle = `rgba(${this.bloomColorR}, ${this.bloomColorG}, ${this.bloomColorB}, ${pathAlpha})`;
                    
                    ctx.beginPath();
                    ctx.moveTo(path[0].x, path[0].y);
                    for (let i = 1; i < path.length; i++) {
                        ctx.lineTo(path[i].x, path[i].y);
                    }
                    ctx.stroke();
                }
                ctx.restore();
            }
        } else {
            // Draw a solid color path instead of glow
            for (let pIdx = 0; pIdx < this.generatedPaths.length; pIdx++) {
                const pathObj = this.generatedPaths[pIdx];
                const path = pathObj.points;
                const pathWidth = this.boltWidth * pathObj.width;
                
                ctx.lineWidth = pathWidth;
                ctx.strokeStyle = `rgba(${this.colorR}, ${this.colorG}, ${this.colorB}, ${this.colorA})`;
                
                ctx.beginPath();
                ctx.moveTo(path[0].x, path[0].y);
                for (let i = 1; i < path.length; i++) {
                    ctx.lineTo(path[i].x, path[i].y);
                }
                ctx.stroke();
            }
        }

        // Draw white hot core
        for (let pIdx = 0; pIdx < this.generatedPaths.length; pIdx++) {
            const pathObj = this.generatedPaths[pIdx];
            const path = pathObj.points;
            ctx.lineWidth = this.boltWidth * pathObj.width * 0.4;
            ctx.strokeStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(path[0].x, path[0].y);
            for (let i = 1; i < path.length; i++) {
                ctx.lineTo(path[i].x, path[i].y);
            }
            ctx.stroke();
        }

        ctx.restore();
    }
    findMaskIntersection(startX, startY, targetX, targetY, targetName) {
        if (!window.targetUI) return { x: targetX, y: targetY };

        const dx = targetX - startX;
        const dy = targetY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 10) return { x: targetX, y: targetY };

        // Linear trace with 100 steps from origin to target center
        const steps = 100;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const px = startX + dx * t;
            const py = startY + dy * t;
            if (window.targetUI.isHit(px, py, targetName)) {
                return { x: px, y: py };
            }
        }
        return { x: targetX, y: targetY };
    }

    destroy() {
        console.log(`[WebGLLightning] destroy() called. Fallback mode: ${this.isFallback}`);
        this.generatedPaths = [];
    }
}
window.WebGLLightning = WebGLLightning;
