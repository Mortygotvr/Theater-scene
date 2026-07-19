class StaticEntity {
    constructor(config = {}) {
        this.imageId = config.imageId || null;
        this.targetElement = config.targetElement || null;
        this.targetRect = config.targetRect || null; // Snapshot of the target coordinates AT SPAWN
        this.fallbackX = config.fallbackX || (window.innerWidth / 2);
        this.fallbackY = config.fallbackY || (window.innerHeight / 2);
        this.xOffset = config.xOffset || 0;
        this.yOffset = config.yOffset || 0;
        this.duration = config.duration || 5000;
        this.scale = config.scale || 1.0;
        this.triggerCollision = config.triggerCollision || false;
        this.collisionTimer = config.collisionTimer || 0;
        this.collisionActions = config.collisionActions || null;
        this.lastCollisionActions = config.lastCollisionActions || null;
        this.collisionSound = config.collisionSound || null;
        this.payloadData = config.payloadData || {};
        this.wildcards = config.wildcards || [];
        this.isLastInBatch = config.isLastInBatch || false;
        this.avatarReaction = config.avatarReaction || 'bounce';
        
        this.dead = false;
        this.startTime = Date.now();
        this.collisionTriggered = false;

        this.x = 0;
        this.y = 0;
        this.halfWidth = 50;
        this.halfHeight = 50;
        this.imageElement = null;

        if (typeof assets !== 'undefined' && this.imageId) {
            const asset = assets.get(this.imageId);
            if (asset && asset.src) {
                const isGif = asset.src.toLowerCase().startsWith('data:image/gif') || asset.src.toLowerCase().endsWith('.gif');
                
                this.halfWidth = ((asset.width || 100) * this.scale) / 2;
                this.halfHeight = ((asset.height || 100) * this.scale) / 2;

                if (isGif) {
                    this.imageElement = document.createElement('img');
                    this.imageElement.src = asset.src;
                    this.imageElement.style.position = 'absolute';
                    this.imageElement.style.left = '0px';
                    this.imageElement.style.top = '0px';
                    this.imageElement.style.pointerEvents = 'none';
                    this.imageElement.style.transformOrigin = 'center center';
                    this.imageElement.style.zIndex = '4';
                    this.imageElement.style.width = (this.halfWidth * 2) + 'px';
                    this.imageElement.style.height = (this.halfHeight * 2) + 'px';
                    document.body.appendChild(this.imageElement);
                }
            }
        }
        
        this.updatePosition();
    }

    destroy() {
        if (this.imageElement && this.imageElement.parentNode) {
            this.imageElement.parentNode.removeChild(this.imageElement);
            this.imageElement = null;
        }
    }

    updatePosition() {
        if (this.targetRect) {
            const rect = this.targetRect;
            const targetCenterX = rect.left + (rect.width / 2);
            const targetCenterY = rect.top + (rect.height / 2);
            
            const dx = (rect.width * (this.xOffset / 100));
            const dy = (rect.height * (this.yOffset / 100));
            
            this.x = targetCenterX + dx;
            this.y = targetCenterY + dy;
        } else {
            this.x = this.fallbackX;
            this.y = this.fallbackY;
        }
    }

    triggerReaction() {
        if (!this.targetElement) return;
        ReactionSystem.triggerReaction(this.targetElement, this.avatarReaction);
    }

    update(canvasWidth, canvasHeight) {
        if (this.dead) return;
        
        const now = Date.now();
        const elapsed = now - this.startTime;

        if (elapsed > this.duration) {
            this.dead = true;
            return;
        }

        if (this.triggerCollision && !this.collisionTriggered) {
            if (elapsed >= this.collisionTimer) {
                this.triggerReaction();

                // Play Collision Sound
                if (this.collisionSound) {
                    const audio = new Audio(this.collisionSound);
                    audio.play().catch(e => console.warn("[StaticEntity] Collision Audio play blocked", e));
                }

                // Trigger Collision OBS Actions
                if (this.collisionActions && this.collisionActions.length > 0 && window.obsBridge && typeof window.obsBridge.executeActions === 'function') {
                    window.obsBridge.executeActions(this.collisionActions, this.payloadData, this.wildcards).catch(err => {
                        console.error("[Theatre] Trigger OBS Collision Action batch failed (StaticEntity):", err);
                    });
                }
                
                // Trigger Last Collision OBS Actions
                if (this.isLastInBatch && this.lastCollisionActions && this.lastCollisionActions.length > 0 && window.obsBridge && typeof window.obsBridge.executeActions === 'function') {
                    window.obsBridge.executeActions(this.lastCollisionActions, this.payloadData, this.wildcards).catch(err => {
                        console.error("[Theatre] Trigger OBS Last Collision Action batch failed (StaticEntity):", err);
                    });
                }
                
                this.collisionTriggered = true;
            }
        }
        
        this.updatePosition();
    }

    draw(ctx) {
        if (this.imageElement) {
            const tx = this.x - this.halfWidth;
            const ty = this.y - this.halfHeight;
            this.imageElement.style.transform = `translate(${tx}px, ${ty}px)`;
            return;
        }

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(this.scale, this.scale);
        
        const asset = this.imageId ? assets.get(this.imageId) : null;
        if (asset && asset.canvas) {
            ctx.drawImage(asset.canvas, -asset.halfWidth, -asset.halfHeight);
        }
        ctx.restore();
    }
}

