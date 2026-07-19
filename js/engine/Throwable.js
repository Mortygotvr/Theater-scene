class Throwable {
    constructor(x, y, config = {}) {
        this.x = x;
        this.y = y;
        this.vx = config.vx || 0;
        this.vy = config.vy || 0;
        this.gravity = config.gravity !== undefined ? config.gravity : 0.8;
        this.rotation = Math.random() * 360;
        this.vRotation = (Math.random() - 0.5) * 10;
        this.size = config.size || 50;
        this.color = config.color || '#fff';
        this.imageId = config.imageId || null; // For rendering cached assets
        this.targetElement = config.targetElement || null;
        this.targetRect = config.targetRect || null; // Snapshot of the target coordinates AT SPAWN
        this.targetName = config.targetName || null; // The specific Python target name (e.g. Avatar)
        this.targetOffsetX = config.targetOffsetX || 0;
        this.targetOffsetY = config.targetOffsetY || 0;
        this.collisionMethod = config.collisionMethod || 'bounce';
        this.snapBottom = config.snapBottom || false;
        this.randomMirror = config.randomMirror || false;
        this.mirrorX = (this.randomMirror && Math.random() > 0.5) ? -1 : 1;
        this.collisionActions = config.collisionActions || null;
        this.lastCollisionActions = config.lastCollisionActions || null;
        this.collisionSound = config.collisionSound || null;
        this.payloadData = config.payloadData || {};
        this.wildcards = config.wildcards || [];
        this.isLastInBatch = config.isLastInBatch || false;

        this.type = config.type || 'image';

        this.dead = false;
        this.hasHitTarget = false;
        this.bounceCount = 0;
        this.lifeTime = Date.now();
        this.stickTime = null;
        this.baseScale = config.scale !== undefined ? config.scale : 1.0;
        this.scaleX = this.baseScale;
        this.scaleY = this.baseScale;
        
        // Tracking offsets
        this.stickyOffsetX = null;
        this.stickyOffsetY = null;
        this.stickyRelX = null;
        this.stickyRelY = null;
        this.stickyOffsetXPercent = null;
        this.stickyOffsetYPercent = null;
        this.lockedCellCol = null;
        this.lockedCellRow = null;

        // Pre-calculate half-size for performance
        this.halfSize = this.size / 2;
        this.action = config.action || 'throwable';
        this.swirlAngle = Math.random() * Math.PI * 2;
        this.swirlPhase = 0;

        if (this.action === 'swirl') {
            this.swirlRadius = this.size * 3;
            this.scaleX = 3.0 * this.baseScale;
            this.scaleY = 3.0 * this.baseScale;
            this.configSpeed = config.speed;
        }

        if (this.action === 'throw-front') {
            // Store spawn origin so we can lerp straight to the target
            this.frontSpawnX = x;
            this.frontSpawnY = y;
            // Initial approach radius: distance from spawn to target center (resolved at first update)
            this.frontRadius = null; // calculated lazily on first update
            this.frontInitialRadius = null;
            this.scaleX = 3.0 * this.baseScale;
            this.scaleY = 3.0 * this.baseScale;
            this.configSpeed = config.speed;
            this.vx = 0;
            this.vy = 0;
            this.gravity = 0;
        }


        console.log("[DEBUG] Throwable Created. x:", this.x, "y:", this.y, "size:", this.size);
    }

    update(canvasWidth, canvasHeight) {
        if (this.shattered) {
            let activeParticles = 0;
            if (this.particles) {
                for (let p of this.particles) {
                    if (p.alpha > 0) {
                        p.x += p.vx;
                        p.y += p.vy;
                        p.vy += p.gravity;
                        p.alpha -= p.fadeSpeed;
                        activeParticles++;
                    }
                }
            }
            if (activeParticles === 0) {
                this.dead = true;
            }
            return;
        }



        let isStuck = false;

        // --- REAL-TIME STICKY TRACKING ---
        if (this.hasHitTarget && this.collisionMethod === 'stick' && this.targetName) {
            const useTracking = (window.preferencesManager && window.preferencesManager.stickyTracking) !== false;
            const isCanvas = (this.targetElement && this.targetElement.id === 'target-hitbox-canvas');

            if (useTracking && isCanvas && window.targetUI) {
                const t = window.targetUI.targetMap.get(this.targetName.toLowerCase());
                if (t && t.id) {
                    const center = window.targetUI.getTargetCenter(this.targetName);
                    if (center) {
                        if (this.stickyOffsetX === null) {
                            this.stickyOffsetX = this.x - center.x;
                            this.stickyOffsetY = this.y - center.y;
                        }
                        
                        const targetX = center.x + this.stickyOffsetX;
                        const targetY = center.y + this.stickyOffsetY;
                        
                        const config = (typeof window.getTheatreConfig === 'function') ? window.getTheatreConfig() : null;
                        const useSmoothing = (window.preferencesManager && window.preferencesManager.smoothingEnabled !== undefined)
                                             ? window.preferencesManager.smoothingEnabled
                                             : (config?.parallax?.useSmoothing ?? true);
                        
                        const smoothingFactor = config?.parallax?.smoothingFactor ?? 0.15;

                        if (useSmoothing) {
                            this.x += (targetX - this.x) * smoothingFactor;
                            this.y += (targetY - this.y) * smoothingFactor;
                        } else {
                            this.x = targetX;
                            this.y = targetY;
                        }
                        isStuck = true;
                    }
                }
            }
            isStuck = true;
        }

        if (!isStuck) {
            if (this.action === 'swirl' || this.action === 'throw-front') {
                // Determine destination (Target Center)
                let tx = canvasWidth / 2;
                let ty = canvasHeight / 2;

                if (this.targetRect) {
                    tx = this.targetRect.left + (this.targetRect.width / 2) + this.targetOffsetX;
                    ty = this.targetRect.top + (this.targetRect.height / 2) + this.targetOffsetY;
                } else if (this.targetName && window.targetUI) {
                    const center = window.targetUI.getTargetCenter(this.targetName);
                    if (center) {
                        tx = center.x + this.targetOffsetX;
                        ty = center.y + this.targetOffsetY;
                    }
                }

                if (!this.hasHitTarget) {
                    let speedMult = (this.configSpeed && this.configSpeed > 0) ? (this.configSpeed / 10) : 1;

                    if (this.action === 'swirl') {
                        // --- SWIRL: orbital spiral approach ---
                        this.swirlAngle += 0.05 * speedMult;
                        this.swirlRadius -= 0.6 * speedMult;

                        if (this.swirlRadius <= 0) {
                            this.swirlRadius = 0;
                            this.hasHitTarget = true;
                            this._triggerCollision();
                        }

                        this.x = tx + Math.cos(this.swirlAngle) * this.swirlRadius;
                        this.y = ty + Math.sin(this.swirlAngle) * this.swirlRadius;

                        const initialRadius = this.size * 3;
                        const progress = Math.min(1.0, Math.max(0.0, (initialRadius - this.swirlRadius) / initialRadius));
                        const currentScale = (3.0 * this.baseScale) - (progress * (2.0 * this.baseScale));
                        this.scaleX = currentScale;
                        this.scaleY = currentScale;

                        this.rotation += 10;

                    } else {
                        // --- THROW-FRONT: straight zoom-in, no orbit, 2x faster than swirl ---
                        // Lazily initialise radius on first frame (distance from spawn to target)
                        if (this.frontRadius === null) {
                            const ddx = tx - this.frontSpawnX;
                            const ddy = ty - this.frontSpawnY;
                            this.frontInitialRadius = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                            this.frontRadius = this.frontInitialRadius;
                            // Step = distance / frames — completes in ~20 frames at speed 1
                            const targetFrames = 20;
                            this._frontStep = this.frontInitialRadius / targetFrames;
                        }

                        // Shrink by computed step (speed-scaled)
                        this.frontRadius -= this._frontStep * speedMult;

                        if (this.frontRadius <= 0) {
                            this.frontRadius = 0;
                            this.hasHitTarget = true;
                            this._triggerCollision();
                        }

                        // Lerp position straight from spawn origin toward target
                        const t = 1.0 - (this.frontRadius / this.frontInitialRadius);
                        this.x = this.frontSpawnX + (tx - this.frontSpawnX) * t;
                        this.y = this.frontSpawnY + (ty - this.frontSpawnY) * t;

                        // Scale shrinks from 3x to baseScale as it approaches
                        const currentScale = (3.0 * this.baseScale) - (t * (2.0 * this.baseScale));
                        this.scaleX = currentScale;
                        this.scaleY = currentScale;

                        // No spin during approach — keep rotation fixed
                    }

                } else {
                    // After collision, let regular physics take over
                    if (this.collisionMethod === 'stick') {
                        isStuck = true;
                    } else {
                        this.vy += this.gravity;
                        this.x += this.vx;
                        this.y += this.vy;
                    }
                }
            } else {
                // Apply gravity
                this.vy += this.gravity;
                
                // Move
                this.x += this.vx;
                this.y += this.vy;
            }
        }
        
        // Rotate (Always update so rotation doesn't snap to a halt)
        if (this.snapBottom && !isStuck && this.targetName && window.targetUI) {
            // Point the bottom of the object towards the target center
            const bounds = window.targetUI.getTargetBounds(this.targetName);
            if (bounds) {
                const [bx, by, bw, bh] = bounds;
                const tx = bx + (bw / 2);
                const ty = by + (bh / 2);
                const angle = Math.atan2(ty - this.y, tx - this.x);
                this.rotation = (angle * 180 / Math.PI) - 90;
            }
        } else if (!isStuck) {
            this.rotation += this.vRotation;
        }

        // Easing back to normal proportions (Squash & Stretch recovery)
        if (this.action !== 'swirl' || this.hasHitTarget) {
            this.scaleX += (this.baseScale - this.scaleX) * 0.15;
            this.scaleY += (this.baseScale - this.scaleY) * 0.15;
        }

        // Target Element Collision (Only check if not already hit or if bouncing)
        if (this.targetRect && !this.hasHitTarget && this.action !== 'swirl') {
            const offsetX = this.targetOffsetX || 0;
            const offsetY = this.targetOffsetY || 0;
            const hitRadius = this.halfSize;
            
            // 1. Live target mapping
            const rect = {
                top: this.targetRect.top + offsetY,
                bottom: this.targetRect.bottom + offsetY,
                left: this.targetRect.left + offsetX,
                right: this.targetRect.right + offsetX,
                width: this.targetRect.width,
                height: this.targetRect.height
            };

            const targetY = rect.top + (rect.height / 2);
            
            // 2. Initial check (fast filter)
            const isNear = (this.targetElement && this.targetElement.id === 'target-hitbox-canvas') || (
               this.y + hitRadius > rect.top &&
               this.y - hitRadius < rect.bottom &&
               this.x + hitRadius > rect.left &&
               this.x - hitRadius < rect.right
            );

            if (isNear) {
               let isColliding = false;
               
               // 3. Precision Check: Continuous Collision Detection (CCD)
               const steps = Math.max(1, Math.ceil(Math.abs(this.vy) / 5)); 
               for (let s = 0; s < steps; s++) {
                   const t = s / steps;
                   const checkX = this.x - (this.vx * t);
                   const checkY = this.y - (this.vy * t);
                   
                   let subPoints = [[checkX, checkY], [checkX-hitRadius, checkY], [checkX+hitRadius, checkY], [checkX, checkY-hitRadius], [checkX, checkY+hitRadius]];
                   
                   // If snapBottom is enabled, the collision point is always at the leading edge (bottom) 
                   // currently facing the target.
                   if (this.snapBottom && this.targetName && window.targetUI) {
                       const bounds = window.targetUI.getTargetBounds(this.targetName);
                       if (bounds) {
                           const [bx, by, bw, bh] = bounds;
                           const angle = Math.atan2((by + bh/2) - this.y, (bx + bw/2) - this.x);
                           subPoints = [[
                               this.x + Math.cos(angle) * hitRadius,
                               this.y + Math.sin(angle) * hitRadius
                           ]];
                       }
                   }
                   for (const [px, py] of subPoints) {
                       if (window.targetUI && window.targetUI.isHit(px, py, this.targetName)) {
                           isColliding = true;
                           this.x = checkX; this.y = checkY;
                           break;
                       }
                   }
                   if (isColliding) break;
               }

                if (!isColliding && (!this.targetElement || this.targetElement.id !== 'target-hitbox-canvas')) {
                    isColliding = true; 
                }
 
                if (isColliding) {
                    this.hasHitTarget = true;

                    // Trigger Actions
                    if (this.type !== 'liquid') {
                        if (this.collisionSound) {
                            const audio = new Audio(this.collisionSound);
                            audio.play().catch(e => console.warn("[Throwable] Collision Audio play blocked", e));
                        }
                        if (this.collisionActions && window.obsBridge) window.obsBridge.executeActions(this.collisionActions, this.payloadData, this.wildcards);
                        if (this.isLastInBatch && this.lastCollisionActions && window.obsBridge) window.obsBridge.executeActions(this.lastCollisionActions, this.payloadData, this.wildcards);

                        if (this.collisionMethod !== 'pass') {
                            if ((!this.targetElement || this.targetElement.id !== 'target-hitbox-canvas') && this.vy > 0) this.y = targetY - hitRadius;
                            this.scaleX = 1.5 * this.baseScale; this.scaleY = 0.5 * this.baseScale;
                        }
                    }

                    if (this.collisionMethod === 'pixel-shatter') {
                        this.shatter();
                    } else if (this.collisionMethod === 'squish') {
                        this.vx = 0; this.vy = 0.1; this.gravity = 0.1; this.vRotation *= 0.5;
                    } else if (this.collisionMethod === 'stick') {
                        this.vx = 0; this.vy = 0; this.gravity = 0; this.vRotation *= 0.3;
                        this.stickTime = Date.now();
                    } else if (this.collisionMethod !== 'pass') {
                        this.vy = -Math.abs(this.vy) * (0.3 + Math.random() * 0.4); 
                        this.vx = -this.vx * (0.4 + Math.random() * 0.4);
                    }
                    this.bounceCount++;
                }
            }
        }

        // Floor Collision
        const floorY = canvasHeight - 50;
        const useFloor = (window.preferencesManager && window.preferencesManager.floorEnabled) !== false;
        
        if (useFloor && this.y + this.halfSize > floorY && (this.action !== 'swirl' || this.hasHitTarget)) {
            this.y = floorY - this.halfSize;
            if (this.collisionMethod === 'pixel-shatter') {
                this.shatter();
            } else if (this.collisionMethod === 'stick' || this.collisionMethod === 'squish') {
                this.vx = 0; this.vy = 0; this.gravity = 0; this.vRotation = 0;
                if (!this.stickTime) this.stickTime = Date.now();
            } else {
                if (Math.abs(this.vy) < 0.2) {
                    this.vy = 0;
                    this.vx = 0;
                    this.gravity = 0;
                    this.vRotation = 0;
                } else {
                    this.vy = -Math.abs(this.vy) * 0.5;
                    this.vx *= 0.8;
                    this.vRotation *= 0.8;
                    if (this.collisionMethod !== 'pass') {
                        this.scaleX = 1.5 * this.baseScale;
                        this.scaleY = 0.5 * this.baseScale;
                    }
                }
                if (!this.stickTime) this.stickTime = Date.now();
            }
            this.bounceCount++;
        }

        // Screen bounds
        if (this.x < -200 || this.x > canvasWidth + 200 || this.y > canvasHeight + 200) {
            this.dead = true;
        }

        // Duration cleanup
        if (this.stickTime) {
            const duration = (window.preferencesManager && window.preferencesManager.itemDuration) || 3000;
            if (Date.now() - this.stickTime > duration) this.dead = true;
        }
    }

    shatter() {
        if (this.shattered) return;
        this.shattered = true;
        

        
        this.particles = [];
        
        const asset = this.imageId ? assets.get(this.imageId) : null;
        if (asset && asset.canvas) {
            const canvas = asset.canvas;
            const ctx2d = canvas.getContext('2d');
            try {
                const imgData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
                const data = imgData.data;
                const step = 8; // Density step (lower is denser/more pixels)
                
                // Get current rotation in radians
                const rad = this.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);

                for (let y = 0; y < canvas.height; y += step) {
                    for (let x = 0; x < canvas.width; x += step) {
                        const idx = (y * canvas.width + x) * 4;
                        const a = data[idx + 3];
                        if (a > 30) {
                            const r = data[idx];
                            const g = data[idx + 1];
                            const b = data[idx + 2];
                            
                            // Offset relative to center of the image
                            const rx = (x - asset.halfWidth) * this.scaleX * this.mirrorX;
                            const ry = (y - asset.halfHeight) * this.scaleY;
                            
                            // Rotate the offsets to match current rotation
                            const rotX = rx * cos - ry * sin;
                            const rotY = rx * sin + ry * cos;
                            
                            const px = this.x + rotX;
                            const py = this.y + rotY;
                            
                            // Scatter velocity (outward from object center + random)
                            const angle = Math.atan2(rotY, rotX) + (Math.random() - 0.5) * 0.5;
                            const speed = Math.random() * 4 + 2;
                            
                            this.particles.push({
                                x: px,
                                y: py,
                                vx: Math.cos(angle) * speed + (this.vx * 0.1),
                                vy: Math.sin(angle) * speed + (this.vy * 0.1) - 2, // Slight upward pop
                                color: `rgba(${r},${g},${b},${a/255})`,
                                size: step * Math.max(0.5, this.scaleX),
                                alpha: 1.0,
                                fadeSpeed: Math.random() * 0.03 + 0.015,
                                gravity: 0.15
                            });
                        }
                    }
                }
            } catch (e) {
                console.error("Shatter pixel read failed: ", e);
            }
        }
        
        // Fallback for solid color rectangle if no asset or reading fails
        if (this.particles.length === 0) {
            const step = 8;
            const rad = this.rotation * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);

            for (let y = 0; y < this.size; y += step) {
                for (let x = 0; x < this.size; x += step) {
                    const rx = (x - this.halfSize) * this.scaleX * this.mirrorX;
                    const ry = (y - this.halfSize) * this.scaleY;
                    
                    const rotX = rx * cos - ry * sin;
                    const rotY = rx * sin + ry * cos;
                    
                    const px = this.x + rotX;
                    const py = this.y + rotY;
                    
                    const angle = Math.atan2(rotY, rotX) + (Math.random() - 0.5) * 0.5;
                    const speed = Math.random() * 4 + 2;
                    
                    this.particles.push({
                        x: px,
                        y: py,
                        vx: Math.cos(angle) * speed + (this.vx * 0.1),
                        vy: Math.sin(angle) * speed + (this.vy * 0.1) - 2,
                        color: this.color,
                        size: step * Math.max(0.5, this.scaleX),
                        alpha: 1.0,
                        fadeSpeed: Math.random() * 0.03 + 0.015,
                        gravity: 0.15
                    });
                }
            }
        }
    }

    _triggerCollision() {
        // Shared collision handler for swirl and throw-front approaches
        if (this.type !== 'liquid') {
            if (this.collisionSound) {
                const audio = new Audio(this.collisionSound);
                audio.play().catch(e => console.warn("[Throwable] Collision Audio play blocked", e));
            }
            if (this.collisionActions && window.obsBridge) window.obsBridge.executeActions(this.collisionActions, this.payloadData, this.wildcards);
            if (this.isLastInBatch && this.lastCollisionActions && window.obsBridge) window.obsBridge.executeActions(this.lastCollisionActions, this.payloadData, this.wildcards);
        }

        if (this.collisionMethod === 'pixel-shatter') {
            this.shatter();
        } else if (this.collisionMethod === 'squish') {
            this.vx = 0; this.vy = 0.1; this.gravity = 0.1; this.vRotation *= 0.5;
        } else if (this.collisionMethod === 'stick') {
            this.vx = 0; this.vy = 0; this.gravity = 0; this.vRotation *= 0.3;
            this.stickTime = Date.now();
        } else if (this.collisionMethod !== 'pass') {
            this.vy = -Math.abs(5) * (0.3 + Math.random() * 0.4);
            this.vx = (Math.random() - 0.5) * 10;
        }
        this.bounceCount++;
    }

    draw(ctx) {
        if (this.shattered) {
            if (this.particles) {
                ctx.save();
                for (let p of this.particles) {
                    if (p.alpha > 0) {
                        ctx.fillStyle = p.color;
                        ctx.globalAlpha = p.alpha;
                        ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
                    }
                }
                ctx.restore();
            }
            return;
        }

        ctx.save();
        ctx.translate(this.x, this.y);
        // Apply visual squash & stretch in world space (unrotated)
        ctx.scale(this.scaleX / this.baseScale, this.scaleY / this.baseScale);
        ctx.rotate(this.rotation * Math.PI / 180);
        // Apply base scale and mirroring in local space
        ctx.scale(this.baseScale * this.mirrorX, this.baseScale);
        
        const asset = this.imageId ? assets.get(this.imageId) : null;
        if (asset && asset.canvas) {
            ctx.drawImage(asset.canvas, -asset.halfWidth, -asset.halfHeight);
        } else {
            ctx.fillStyle = this.color;
            ctx.fillRect(-this.halfSize, -this.halfSize, this.size, this.size);
        }
        ctx.restore();
    }
}
