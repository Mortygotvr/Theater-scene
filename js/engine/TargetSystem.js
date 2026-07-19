class TargetSystem {
    /**
     * Resolves the target string query to a DOM element and explicit screen coordinates.
     * @param {string} targetQuery - The raw string target from UI/SAMMI (e.g., 'avatar', 'fugi_123')
     * @param {number} canvasWidth - Current window/canvas width
     * @param {number} canvasHeight - Current window/canvas height
     * @param {Object} currentAvatar - Reference to the old canvas avatar object if still in use
     * @returns {Object} { element, x, y, offsetX, offsetY, rect }
     */
    static resolveTarget(targetQuery, canvasWidth, canvasHeight, currentAvatar) {
        let exactEl = null;
        let mediaSources = [];

        // 1. Precise Matching
        if (targetQuery && targetQuery.toLowerCase() !== 'avatar' && targetQuery.toLowerCase() !== 'camera' && targetQuery.trim() !== '') {
            // Check direct ID (fugi_123 or strict names)
            exactEl = document.getElementById(targetQuery);

            if (!exactEl) {
                // By data-name (custom names user assigned)
                const allSources = document.querySelectorAll('.media-source');
                for (let el of allSources) {
                    if (el.dataset.name && el.dataset.name.toLowerCase() === targetQuery.toLowerCase()) {
                        exactEl = el;
                        break;
                    }
                }
            }
            if (exactEl) mediaSources = [exactEl];
        } 
        
        // 2. Resolve Specific Python Hitbox (Pixel Scan)
        if (mediaSources.length === 0 && window.targetUI) {
            const bounds = window.targetUI.getTargetBounds(targetQuery);
            if (bounds) {
                const [bx, by, bw, bh] = bounds;
                return { 
                    element: document.getElementById('target-hitbox-canvas'), 
                    x: bx + (bw / 2), 
                    y: by + (bh / 2), 
                    offsetX: 0, 
                    offsetY: 0, 
                    rect: { top: by, bottom: by+bh, left: bx, right: bx+bw, width: bw, height: bh }
                };
            }
            
            // Generic fallback to any Python target if query is empty
            const anyBounds = window.targetUI.getTargetBounds('Avatar') || window.targetUI.getTargetBounds('Secondary');
            if (anyBounds) {
                // ... logic to pick first available ...
            }
        }

        // 3. Compute Coordinates
        if (mediaSources.length > 0) {
            const element = mediaSources[Math.floor(Math.random() * mediaSources.length)];
            // Retrieve pure absolute coordinates bypassing CSS transforms (which cause infinite parallax feedback loops)
            let rawLeft = 0;
            let rawTop = 0;
            let currentParent = element;
            while (currentParent) {
                rawLeft += currentParent.offsetLeft || 0;
                rawTop += currentParent.offsetTop || 0;
                currentParent = currentParent.offsetParent;
            }
            
            // Base X and Y default to geometric center of the DOM element
            let baseX = rawLeft + (element.offsetWidth / 2);
            let baseY = rawTop + (element.offsetHeight / 2);

            // We no longer apply random deviation here at the system level. 
            // The physics engine (app.js) handles deviation per-action explicitly.
            const targetOffsetX = 0;
            const targetOffsetY = 0;

            const targetX = baseX;
            const targetY = baseY;

            // Build rect for collision detection in Throwable.js
            const domRect = element.getBoundingClientRect();
            const rect = {
                top: domRect.top,
                bottom: domRect.bottom,
                left: domRect.left,
                right: domRect.right,
                width: domRect.width,
                height: domRect.height,
                isObsHitbox: element.dataset.isObsHitbox === 'true'
            };

            return { element, x: targetX, y: targetY, offsetX: targetOffsetX, offsetY: targetOffsetY, rect };
        }

        // 4. Final Absolute Coordinate Fallback (No DOM elements hit)
        let targetX = canvasWidth / 2;
        let targetY = canvasHeight / 2;
        
        if (currentAvatar) {
            targetX = currentAvatar.x;
            let heightMultiplier = currentAvatar.baseScale || 1.0;
            targetY = currentAvatar.y - (150 * heightMultiplier); // chest height scaled mathematically
        } else {
            targetX = canvasWidth / 2;
            targetY = canvasHeight - 150;
        }

        return { 
            element: null, 
            x: targetX, 
            y: targetY, 
            offsetX: 0, 
            offsetY: 0, 
            rect: { top: targetY - 25, bottom: targetY + 25, left: targetX - 25, right: targetX + 25, width: 50, height: 50 } 
        };
    }
}

