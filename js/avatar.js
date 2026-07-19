class Avatar {
    constructor(config = {}) {
        this.idleId = config.idleId || null;
        this.speakingId = config.speakingId || null;
        
        this.offsetX = config.avatarOffsetX || 0;
        this.offsetY = config.avatarOffsetY || 0;
        this.parallaxOffsetX = 0;
        this.parallaxOffsetY = 0;
        this.baseScale = config.avatarBaseScale || 1.0;

        this.x = (window.innerWidth / 2) + this.offsetX;
        this.y = window.innerHeight + this.offsetY;
        this.bobTime = 0;
        this.bobSpeed = config.bobSpeed || 0.05;
        this.bobAmount = config.bobAmount || 10;
        
        // Reactive scale (for when hit by items)
        this.scaleX = 1.0;
        this.scaleY = 1.0;
    }

    update(width, height) {
        // Keep positioned bottom center if resizing (plus manual drag offsets)
        this.x = (width / 2) + this.offsetX;
        this.y = height + this.offsetY;

        // Bobbing animation
        this.bobTime += this.bobSpeed;
        const currentBobAmount = this.isSpeaking ? this.bobAmount * 2 : this.bobAmount;
        this.bobOffset = Math.sin(this.bobTime) * currentBobAmount;

        // Recover scale
        this.scaleX += (1.0 - this.scaleX) * 0.1;
        this.scaleY += (1.0 - this.scaleY) * 0.1;
    }

    draw(ctx) {
        const currentId = this.isSpeaking && this.speakingId ? this.speakingId : this.idleId;
        const asset = assets.get(currentId);

        ctx.save();
        ctx.translate(this.x + this.parallaxOffsetX, this.y + this.parallaxOffsetY);
        ctx.scale(this.scaleX * this.baseScale, this.scaleY * this.baseScale);

        if (asset) {
            // Draw image anchored at bottom center, applying bob offset
            ctx.drawImage(
                asset.canvas, 
                -asset.halfWidth, 
                -asset.height - this.bobOffset
            );

        }

        ctx.restore();
    }
}