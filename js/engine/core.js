const canvas = document.getElementById('theatre-canvas');
const ctx = canvas.getContext('2d');

let width, height;
let entities = [];
let avatar;

function initWebGLCanvas() {
    if (!window._webglCanvas) {
        window._webglCanvas = document.createElement('canvas');
        window._webglCanvas.width = width || window.innerWidth;
        window._webglCanvas.height = height || window.innerHeight;
        window._webglContext = window._webglCanvas.getContext('webgl', { 
            alpha: true, 
            premultipliedAlpha: false,
            antialias: true,
            preserveDrawingBuffer: true
        });
        if (!window._webglContext) {
            console.error("WebGL not supported for cartoon water stream.");
        }
    }
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    width = canvas.width;
    height = canvas.height;
    
    if (window._webglCanvas) {
        window._webglCanvas.width = width;
        window._webglCanvas.height = height;
        if (window._webglContext) {
            window._webglContext.viewport(0, 0, width, height);
        }
    }
}

window.addEventListener('resize', resize);
resize();

// Load some default assets
async function init() {
    initWebGLCanvas();
    // You would replace these URLs with your actual local or remote image files.
    // assets.load("item_heart", "images/heart.png", 60);
    // assets.load("avatar_idle", "images/avatar_idle.png", 500);

    // Initial config load for avatar scale/offset
    let initScale = 1.0;
    let initOffsetX = 0;
    let initOffsetY = 0;
    try {
        const confStr = localStorage.getItem('theatre_config');
        if (confStr) {
            const conf = JSON.parse(confStr);
            if (conf.avatarBaseScale) initScale = conf.avatarBaseScale;
            if (conf.avatarOffsetX) initOffsetX = conf.avatarOffsetX;
            if (conf.avatarOffsetY) initOffsetY = conf.avatarOffsetY;
        }
    } catch(e) {}

    avatar = new Avatar({
        idleId: "avatar_idle",
        speakingId: "avatar_speak",
        avatarBaseScale: initScale,
        avatarOffsetX: initOffsetX,
        avatarOffsetY: initOffsetY
    });



    render();
}



let dynamicSpawnCounter = 0;

// Internal actual spawn logic to avoid reloading images or resetting loops on same payload
async function spawnSingleEntity(config) {
    let finalImageId = config.finalImageId; // Pre-loaded if dynamic

    // Play start sound if present
    if (config.startSound) {
        const audio = new Audio(config.startSound);
        audio.play().catch(e => console.warn("Audio play blocked", e));
    }

    // If it's pure audio, we're done here. No physics required.
    if (config.type === 'audio') {
        return;
    }

    // If it's a live camera snapshot, capture + cut out at this exact moment
    if (config.type === 'snapshot') {
        if (!window.sourceCapture) {
            console.warn('[Theatre] SourceCapture module not loaded.');
            return;
        }
        const captured = await window.sourceCapture.captureForObject(config);
        if (!captured) {
            console.warn('[Theatre] Snapshot capture failed — skipping throw.');
            return;
        }
        
        // Cache the captured snapshot image dynamically at its actual (resized to 256 max) dimensions
        const hash = captured.imageSrc.length + "_" + captured.imageSrc.substring(0, 10) + captured.imageSrc.substring(captured.imageSrc.length - 10);
        const tempId = 'dynamic_img_' + hash;
        if (typeof assets !== 'undefined') {
            if (!assets.get(tempId)) {
                // Load at the actual 256-resized height returned by SourceCapture.js
                await assets.loadAndResizeStatic(tempId, captured.imageSrc, captured.height);
            }
        }

        // Apply scale: calculate scaleFactor to go from captured.height (<= 256) to config.targetHeight (desired throw height)
        const desiredHeight = config.targetHeight || 200;
        const scaleFactor = desiredHeight / captured.height;

        // Promote to a regular image throw with scaled collision width/height, the live capture image source, and the computed scale factor
        config = { 
            ...config, 
            type: 'image', 
            imageSrc: captured.imageSrc, 
            width: captured.width * scaleFactor, 
            height: captured.height * scaleFactor, 
            scale: scaleFactor,
            finalImageId: tempId 
        };
        finalImageId = tempId;
    }


    // Determine target location (Reactive element)
    const targetQuery = config.target || 'avatar';
    
    // Utilize the new modular TargetSystem
    const resolved = TargetSystem.resolveTarget(targetQuery, width, height, typeof avatar !== 'undefined' ? avatar : null);
    
    console.log("[DEBUG] spawnSingleEntity TYPE:", config.type);
    console.log("[DEBUG] spawnSingleEntity TARGET:", targetQuery);
    console.log("[DEBUG] spawnSingleEntity RESOLVED X/Y:", resolved.x, resolved.y);
    console.log("[DEBUG] spawnSingleEntity RESOLVED ELEM:", resolved.element);

    let targetX = resolved.x;
    let targetY = resolved.y;
    let targetElement = resolved.element;
    let targetOffsetX = resolved.offsetX;
    let targetOffsetY = resolved.offsetY;

    let startX, startY, vx, vy;
    let entityGravity = 0.8;
    const action = config.action || 'throwable';

    // Apply explicit targeting deviation for throws and rain (skip for precision drops)
    if (resolved.rect && (action === 'throwable' || action === 'throw-front' || action === 'rain')) {
        targetOffsetX = (resolved.rect.width * 0.2) * (Math.random() - 0.5);
        targetOffsetY = (resolved.rect.height * 0.2) * (Math.random() - 0.5);
        targetX += targetOffsetX;
        targetY += targetOffsetY;
    }

    if (config.type !== 'staticimage') {
        if (config.type === 'webgl-water' || config.type === 'webgl-fire' || config.type === 'webgl-lightning') {
            const mode = config.streamMode || 'grid';
            if (mode === 'top') {
                let xLean = 0;
                if (config.spawnPoints && Array.from(config.spawnPoints).length > 0) {
                    const pts = Array.from(config.spawnPoints);
                    const pick = pts[Math.floor(Math.random() * pts.length)];
                    if (pick === 'ml' || pick === 'tl' || pick === 'bl') xLean = -(60 + Math.random() * 60);
                    if (pick === 'mr' || pick === 'tr' || pick === 'br') xLean =   60 + Math.random() * 60;
                }
                startX = targetX + xLean + (Math.random() * 20 - 10);
                startY = 0;
            } else {
                if (config.spawnPoints && Array.from(config.spawnPoints).length > 0) {
                    const pts = Array.from(config.spawnPoints);
                    const choice = pts[Math.floor(Math.random() * pts.length)];
                    const map = {
                        tl: { x: -100, y: -100 },
                        tc: { x: width / 2, y: -100 },
                        tr: { x: width + 100, y: -100 },
                        ml: { x: -100, y: height / 2 },
                        mc: { x: width / 2, y: height / 2 },
                        mr: { x: width + 100, y: height / 2 },
                        bl: { x: -100, y: height + 100 },
                        bc: { x: width / 2, y: height + 100 },
                        br: { x: width + 100, y: height + 100 }
                    };
                    const pos = map[choice] || map['mc'];
                    startX = pos.x;
                    startY = pos.y;
                } else {
                    startX = width / 2;
                    startY = -100;
                }
            }
            vx = 0;
            vy = 0;
        } else if (action === 'drop-top' || action === 'drop') {
            startX = targetX;
            startY = -100;
            vx = 0; 
            vy = 0;
            entityGravity = 1.2;
        } else if (action === 'rain') {
            startX = targetX + (Math.random() * 200 - 100);
            startY = -100;
            vx = (targetX - startX) * 0.01;
            vy = Math.random() * 2;
            entityGravity = 0.8 + (Math.random() * 0.4);
        } else if (action === 'swirl') {
            startX = width / 2;
            startY = height / 2;
            vx = 0;
            vy = 0;
            entityGravity = 0;
        } else if (action === 'throw-front') {
            // Spawns at screen center — Throwable.js drives all movement for this action (straight zoom-in)
            startX = width / 2 + (Math.random() * 100 - 50);
            startY = height / 2 + (Math.random() * 80 - 40);
            vx = 0;
            vy = 0;
            entityGravity = 0;
        } else {
            // Default 'throwable' — uses spawnPoints grid or random left/right sides
            if (config.spawnPoints && Array.from(config.spawnPoints).length > 0) {
                const pts = Array.from(config.spawnPoints);
                const choice = pts[Math.floor(Math.random() * pts.length)];
                const map = {
                    tl: { x: -100, y: -100 },
                    tc: { x: width / 2, y: -100 },
                    tr: { x: width + 100, y: -100 },
                    ml: { x: -100, y: height / 2 },
                    mc: { x: width / 2, y: height / 2 },
                    mr: { x: width + 100, y: height / 2 },
                    bl: { x: -100, y: height + 100 },
                    bc: { x: width / 2, y: height + 100 },
                    br: { x: width + 100, y: height + 100 }
                };
                const pos = map[choice] || map['mc'];
                startX = pos.x;
                startY = pos.y;
            } else {
                startX = Math.random() > 0.5 ? -100 : width + 100;
                startY = height - (Math.random() * 400 + 100);
            }

            const dx = targetX - startX;
            const dy = targetY - startY;
            let speedMult = (config.speed && config.speed > 0) ? (config.speed / 10) : 1;
            const timeToHit = (30 + Math.random() * 20) / speedMult;
            vx = dx / timeToHit;
            entityGravity = 0.8;
            vy = (dy - 0.5 * entityGravity * (timeToHit * timeToHit)) / timeToHit;
        }
    }

    let isLastInBatch = false;
    if (config._isLastInBatch) isLastInBatch = true;

    let collisionMethod = config.collision || 'bounce';
    if (config.bounceUntilLast) {
        if (!isLastInBatch) {
            collisionMethod = 'bounce';
        }
    }

    if (config.type === 'staticimage') {
        entities.push(new StaticEntity({
            imageId: finalImageId,
            targetElement: targetElement,
            targetRect: resolved.rect,
            xOffset: config.xOffset !== undefined ? config.xOffset : 0,
            yOffset: config.yOffset !== undefined ? config.yOffset : 0,
            duration: config.duration !== undefined ? config.duration : ((window.preferencesManager && window.preferencesManager.itemDuration !== undefined) ? window.preferencesManager.itemDuration : 3000),
            scale: config.scale || 1.0,
            triggerCollision: config.triggerCollision || false,
            collisionTimer: config.collisionTimer || 0,
            avatarReaction: config.avatarReaction || 'bounce',
            collisionActions: config.collisionActions,
            lastCollisionActions: config.lastCollisionActions,
            collisionSound: config.collisionSound,
            payloadData: config.payloadData,
            wildcards: config.wildcards,
            isLastInBatch: isLastInBatch
        }));
    } else {
        // config.width/height already have scale baked in from the UI slider (obj.width = originalWidth * scale).
        // So calculatedSize should NOT multiply by scale again — the asset is loaded at those exact dimensions.
        const rawWidth = config.width || 0;
        const rawHeight = config.height || 0;
        const objScale = config.scale || 1.0;
        // Compute the natural (unscaled) half-size for collision radius, then let scale handle the rest in drawing
        const calculatedSize = config._isStamp
            ? 256
            : (rawWidth > 0 ? Math.max(rawWidth, rawHeight) / 2 : (Math.random() * 20 + 20));
        console.log("[DEBUG] Spawning throwable stamp with scale:", objScale, "computed size:", calculatedSize);
        if (config.type === 'webgl-water') {
            entities.push(new WebGLWaterStream(startX, startY, {
                vx:             vx,
                vy:             vy,
                colorR:         config.colorR,
                colorG:         config.colorG,
                colorB:         config.colorB,
                colorA:         config.colorA,
                color2R:        config.color2R,
                color2G:        config.color2G,
                color2B:        config.color2B,
                color2A:        config.color2A,
                borderThickness: config.borderThickness !== undefined ? config.borderThickness : 0.06,
                fluidCount:     config.fluidCount      !== undefined ? config.fluidCount      : 150,
                fluidRadius:    config.fluidRadius     !== undefined ? config.fluidRadius     : 15,
                fluidViscosity: config.fluidViscosity  !== undefined ? config.fluidViscosity  : 0.5,
                fluidDuration:  config.fluidDuration   !== undefined ? config.fluidDuration   : 6000,
                fluidGravity:   config.fluidGravity    !== undefined ? config.fluidGravity    : 0.8,
                fluidWidth:     config.fluidWidth      !== undefined ? config.fluidWidth      : 30,
                dripShrink:     config.dripShrink      !== undefined ? config.dripShrink      : 16,
                dripThroughPercent: config.dripThroughPercent !== undefined ? config.dripThroughPercent : 50,
                enableOutline:  config.enableOutline   !== undefined ? config.enableOutline   : true,
                streamMode:     config.streamMode      || 'grid',
                spawnPoints:    config.spawnPoints,
                targetElement:  targetElement,
                targetName:     targetQuery,
                targetRect:     resolved.rect,
                targetOffsetX:  targetOffsetX,
                targetOffsetY:  targetOffsetY,
                targetWX:       targetX,
                targetWY:       targetY
            }));
        } else if (config.type === 'webgl-fire') {
            entities.push(new WebGLFireStream(startX, startY, {
                vx:             vx,
                vy:             vy,
                colorR:         config.colorR !== undefined ? config.colorR : 255,
                colorG:         config.colorG !== undefined ? config.colorG : 80,
                colorB:         config.colorB !== undefined ? config.colorB : 0,
                colorA:         config.colorA !== undefined ? config.colorA : 0.95,
                color2R:        config.color2R !== undefined ? config.color2R : 255,
                color2G:        config.color2G !== undefined ? config.color2G : 220,
                color2B:        config.color2B !== undefined ? config.color2B : 0,
                color2A:        config.color2A !== undefined ? config.color2A : 0.85,
                borderThickness: config.borderThickness !== undefined ? config.borderThickness : 0.08,
                fluidCount:     config.fluidCount      !== undefined ? config.fluidCount      : 400,
                fluidRadius:    config.fluidRadius     !== undefined ? config.fluidRadius     : 16,
                fluidViscosity: config.fluidViscosity  !== undefined ? config.fluidViscosity  : 0.6,
                fluidDuration:  config.fluidDuration   !== undefined ? config.fluidDuration   : 3000,
                fluidGravity:   config.fluidGravity    !== undefined ? config.fluidGravity    : -0.4,
                fluidWidth:     config.fluidWidth      !== undefined ? config.fluidWidth      : 35,
                dripShrink:     config.dripShrink      !== undefined ? config.dripShrink      : 25,
                dripThroughPercent: config.dripThroughPercent !== undefined ? config.dripThroughPercent : 0,
                enableOutline:  config.enableOutline   !== undefined ? config.enableOutline   : true,
                streamMode:     config.streamMode      || 'grid',
                spawnPoints:    config.spawnPoints,
                targetElement:  targetElement,
                targetName:     targetQuery,
                targetRect:     resolved.rect,
                targetOffsetX:  targetOffsetX,
                targetOffsetY:  targetOffsetY,
                targetWX:       targetX,
                targetWY:       targetY
            }));
        } else if (config.type === 'webgl-lightning') {
            entities.push(new WebGLLightning(startX, startY, {
                vx:             vx,
                vy:             vy,
                colorR:         config.colorR !== undefined ? config.colorR : 180,
                colorG:         config.colorG !== undefined ? config.colorG : 220,
                colorB:         config.colorB !== undefined ? config.colorB : 255,
                colorA:         config.colorA !== undefined ? config.colorA : 1.0,
                strikeCount:    config.strikeCount    !== undefined ? config.strikeCount    : 3,
                boltCount:      config.boltCount      !== undefined ? config.boltCount      : 2,
                branching:      config.branching      !== undefined ? config.branching      : 3,
                boltWidth:      config.boltWidth      !== undefined ? config.boltWidth      : 4.0,
                duration:       config.duration       !== undefined ? config.duration       : 500,
                speed:          config.speed          !== undefined ? config.speed          : 1.0,
                enableBloom:    config.enableBloom    !== undefined ? config.enableBloom    : true,
                maxIterations:  config.maxIterations  !== undefined ? config.maxIterations  : 5,
                bloomColorR:    config.bloomColorR    !== undefined ? config.bloomColorR    : config.colorR,
                bloomColorG:    config.bloomColorG    !== undefined ? config.bloomColorG    : config.colorG,
                bloomColorB:    config.bloomColorB    !== undefined ? config.bloomColorB    : config.colorB,
                bloomColorA:    config.bloomColorA    !== undefined ? config.bloomColorA    : config.colorA,
                bloomSize:      config.bloomSize      !== undefined ? config.bloomSize      : 1.0,
                roughness:      config.roughness      !== undefined ? config.roughness      : 0.85,
                straightness:   config.straightness   !== undefined ? config.straightness   : 0.6,
                stopAtMask:     config.stopAtMask     !== undefined ? config.stopAtMask     : false,
                spawnPoints:    config.spawnPoints,
                targetElement:  targetElement,
                targetName:     targetQuery,
                targetRect:     resolved.rect,
                targetOffsetX:  targetOffsetX,
                targetOffsetY:  targetOffsetY,
                targetWX:       targetX,
                targetWY:       targetY
            }));
        } else {
        entities.push(new Throwable(startX, startY, {
            type: config.type,
            vx: vx,
            vy: vy,
            gravity: entityGravity,
            action: action,
            color: config.color,
            imageId: finalImageId,
            targetElement: targetElement,
            targetName: targetQuery,
            targetRect: resolved.rect,
            targetOffsetX: targetOffsetX,
            targetOffsetY: targetOffsetY,
            size: calculatedSize,
            scale: objScale,
            collisionMethod: collisionMethod,
            snapBottom: config.snapBottom || false,
            randomMirror: config.randomMirror || false,
            collisionActions: config.collisionActions,
            lastCollisionActions: config.lastCollisionActions,
            collisionSound: config.collisionSound,
            payloadData: config.payloadData,
            wildcards: config.wildcards,
            isLastInBatch: isLastInBatch,
            liquidDensity: config.liquidDensity,
            liquidSize: config.liquidSize,
            liquidSpeed: config.liquidSpeed,
            liquidDuration: config.liquidDuration,
            liquidMetaballs: config.liquidMetaballs,
            liquidTrails: config.liquidTrails || false,
            liquidSplat: config.liquidSplat !== undefined ? config.liquidSplat : 6.0,
            liquidBounce: config.liquidBounce !== undefined ? config.liquidBounce : 20
        }));
        }
    }

    // --- Entity Limit Bounding ---
    const maxEntities = (window.preferencesManager && window.preferencesManager.maxEntities) ? window.preferencesManager.maxEntities : 100;
    while (entities.length > maxEntities) {
        let old = entities.shift();
        if (old && typeof old.destroy === 'function') old.destroy();
    }
}

// Expose spawn function
window.spawnItem = async function spawnItem(config = {}) {
      // Top level delay wrap (e.g. Pure audio delay, or delayed triggering)
    if (config.delay && config.delay > 0 && !config._isDelayed) {
        const delayedConfig = { ...config, _isDelayed: true };
        setTimeout(() => spawnItem(delayedConfig), config.delay);
        return;
    }


    let finalImageId = config.imageId;

    // Handle dynamic base64 injection - Re-use existing images to prevent 4GB RAM leak
    if (config.imageSrc && (!finalImageId || (typeof assets !== 'undefined' && !assets.get(finalImageId)))) {
        // Use a simple hash of the source string as the ID
        const hash = config.imageSrc.length + "_" + config.imageSrc.substring(0, 10) + config.imageSrc.substring(config.imageSrc.length - 10);
        const tempId = 'dynamic_img_' + hash;
        
        // Calculate target dimensions to fit the image within a 256x256 bounding box, preserving aspect ratio.
        const ow = config.originalWidth || config.width || 100;
        const oh = config.originalHeight || config.height || 100;
        let targetHeight = 256;
        if (ow >= oh) {
            targetHeight = Math.max(1, Math.round(256 * oh / ow));
        } else {
            targetHeight = 256;
        }

        // Load into cache dynamically ONLY if it doesn't exist
        if (typeof assets !== 'undefined') {
            if (!assets.get(tempId)) {
                const isGif = config.imageSrc.toLowerCase().startsWith('data:image/gif') || config.imageSrc.toLowerCase().endsWith('.gif');
                if (isGif) {
                    await assets.loadAnimatedGif(tempId, config.imageSrc, targetHeight);
                } else {
                    await assets.loadAndResizeStatic(tempId, config.imageSrc, targetHeight);
                }
            }
            finalImageId = tempId;
        }

        // Apply scale:
        // config.height already has the UI slider scale baked in. We compute the scaleFactor
        // to scale the 256px cached image (height = targetHeight) to the desired visual height.
        const desiredHeight = config.height || 100;
        const scaleFactor = desiredHeight / targetHeight;
        config.scale = scaleFactor;
    }

    config.finalImageId = finalImageId;

    const amount = config.amount || 1;
    const repeatTime = config.repeatTime !== undefined ? config.repeatTime : 200;

    for (let i = 0; i < amount; i++) {
        const isLastInBatch = (i === amount - 1);
        const loopConfig = { ...config, _isLastInBatch: isLastInBatch };
        
        if (i === 0) {
            spawnSingleEntity(loopConfig);
        } else {
            setTimeout(() => spawnSingleEntity(loopConfig), repeatTime * i);
        }
    }
}

// Initialize WebSocket triggers
window.spawnItem = spawnItem;
const triggers = new TriggerSystem(spawnItem);
window.theatreWs = triggers;

// Main Game Loop - Fixed Timestep for perfectly smooth physics 
let lastTime = 0;
let accumulator = 0;
const TIME_STEP = 1000 / 60; // Locked to 60 FPS calculations

function render(time) {
    try {
        if (!time) {
            requestAnimationFrame(render);
            return;
        }
        if (!lastTime) lastTime = time;
    
    let dt = time - lastTime;
    lastTime = time;

    accumulator += dt;
    
    // Prevent death spiral by capping accumulator to a maximum of 3 steps per frame
    if (accumulator > TIME_STEP * 3) {
        accumulator = TIME_STEP * 3;
    }

    // Enforce max limit continuously so dropping the setting clears the screen instantly
    const currentMax = (window.preferencesManager && window.preferencesManager.maxEntities) ? window.preferencesManager.maxEntities : 100;
    while (entities.length > currentMax) {
        let old = entities.shift();
        if (old && typeof old.destroy === 'function') old.destroy();
    }

    // 1. UPDATE PHYSICS (Runs consistently regardless of monitor refresh rate)
    while (accumulator >= TIME_STEP) {
        if (avatar) {
            avatar.update(width, height);
        }

        for (let i = entities.length - 1; i >= 0; i--) {
            let p = entities[i];
            p.update(width, height);

            // Simple hit detection (if items are falling near the avatar)
            if (avatar && !p.dead && p.y > height - 200 && Math.abs(p.x - width/2) < 100 && p.bounceCount === 0) {
                 // Prevent multiple hits from same item on way down
                 p.bounceCount++; 
            }

            if (p.dead) {
                if (typeof p.destroy === 'function') p.destroy();
                entities.splice(i, 1);
            }
        }
        
        accumulator -= TIME_STEP;
    }

    // 2. PARALLAX UPDATE
    let parallaxDriver = 'camera'; // default
    if (typeof window.getTheatreConfig === 'function') {
        const config = window.getTheatreConfig();
        if (config && config.parallax && config.parallax.driverSource) {
            parallaxDriver = config.parallax.driverSource;
        }
    }

    if (activeParallaxDriverId !== parallaxDriver) {
        activeParallaxDriverId = parallaxDriver;
        window.resetParallaxBaseline();
    }


    let rawAxisX = null;
    let rawAxisY = null;
    let rawAxisZ = null; // New Axis for Zoom based on Mass

    if (parallaxDriver === 'mouse') {
        // Handled by mousemove listener
    } else {
        // Use the exact same True Center of Mass (CoM) engine used for the Drop targeting!
        // The driver dropdown values are 'camera' or 'reactive_fugiID'
        let targetQuery = parallaxDriver;
        if (parallaxDriver === 'camera') targetQuery = 'avatar';
        else if (parallaxDriver.startsWith('reactive_')) targetQuery = parallaxDriver.replace('reactive_', '');

        if (parallaxDriver.startsWith('reactive_')) {
            const el = document.getElementById(targetQuery);
            if (el) {
                // Read base left/top ignoring CSS transform
                let rawLeft = parseFloat(el.style.left) || 0;
                let rawTop = parseFloat(el.style.top) || 0;
                // Important: Fugi reactives represent their drag positions using pure CSS "left" and "top".
                let w = parseFloat(el.style.width) || parseInt(window.getComputedStyle(el).width) || 300;
                let h = parseFloat(el.style.height) || parseInt(window.getComputedStyle(el).height) || 300;
                rawAxisX = ((rawLeft + w / 2) - width / 2) / (width / 2);
                rawAxisY = ((rawTop + h / 2) - height / 2) / (height / 2);
                rawAxisZ = w * h; // The element's area as "Mass"
            }
        } else {
            const resolved = typeof TargetSystem !== 'undefined' 
                ? TargetSystem.resolveTarget(targetQuery, width, height, avatar)
                : null;

            if (resolved && resolved.x !== undefined && resolved.y !== undefined) {
                 let resX = resolved.x;
                 let resY = resolved.y;
                 
                 // We now use pure absolute offset coordinates from TargetSystem, 
                 // which completely ignores CSS transform visual shifts.
                 // No need to manually subtract parallax offsets here anymore!

                 rawAxisX = (resX - width / 2) / (width / 2);
                 rawAxisY = (resY - height / 2) / (height / 2);
            }
        }
    }

    let useSmoothing = false;
    let emaSmoothingFactor = 0.15;
    if (typeof window.getTheatreConfig === 'function') {
        const tempConfig = window.getTheatreConfig();
        if (tempConfig && tempConfig.parallax) {
            if (tempConfig.parallax.useSmoothing) useSmoothing = true;
            if (tempConfig.parallax.smoothingFactor !== undefined) emaSmoothingFactor = tempConfig.parallax.smoothingFactor;
        }
    }

    if (rawAxisX !== null && rawAxisY !== null && rawAxisZ !== null) {
        let finalAxisX = rawAxisX;
        let finalAxisY = rawAxisY;
        let finalAxisZ = rawAxisZ;

        // Apply EMA filter if configured in settings
        if (useSmoothing) {
            if (emaRawAxisX === null) emaRawAxisX = rawAxisX;
            else emaRawAxisX = emaRawAxisX + (rawAxisX - emaRawAxisX) * emaSmoothingFactor;
            
            if (emaRawAxisY === null) emaRawAxisY = rawAxisY;
            else emaRawAxisY = emaRawAxisY + (rawAxisY - emaRawAxisY) * emaSmoothingFactor;
            
            if (emaRawAxisZ === null) emaRawAxisZ = rawAxisZ;
            else emaRawAxisZ = emaRawAxisZ + (rawAxisZ - emaRawAxisZ) * emaSmoothingFactor;
            
            finalAxisX = emaRawAxisX;
            finalAxisY = emaRawAxisY;
            finalAxisZ = emaRawAxisZ;
        } else {
            emaRawAxisX = null;
            emaRawAxisY = null;
            emaRawAxisZ = null;
        }

        if (parallaxBaselineX === null) parallaxBaselineX = finalAxisX;
        if (parallaxBaselineY === null) parallaxBaselineY = finalAxisY;
        if (parallaxBaselineZ === null) parallaxBaselineZ = finalAxisZ;
        
        targetAxisX = finalAxisX - parallaxBaselineX;
        targetAxisY = finalAxisY - parallaxBaselineY;
        
        // Z-axis calculates mathematically relative scale: if mass increases 20%, result is 0.20
        targetAxisZ = (parallaxBaselineZ > 0) ? (finalAxisZ - parallaxBaselineZ) / parallaxBaselineZ : 0;
    }

    // Note: If driver is 'mouse', targetAxisX/Y are safely updated by the mousemove event listener at the bottom of the file
    
    if (useSmoothing) {
        // Tie rendering lerp proportionally to the EMA factor
        let lerpFactor = emaSmoothingFactor * 0.5;
        
        let moveDX = (targetAxisX - currentAxisX) * lerpFactor;
        let moveDY = (targetAxisY - currentAxisY) * lerpFactor;
        let moveDZ = (targetAxisZ - currentAxisZ) * lerpFactor;
        
        // Prevent giant leaps
        if (moveDX > 0.05) moveDX = 0.05;
        if (moveDX < -0.05) moveDX = -0.05;
        if (moveDY > 0.05) moveDY = 0.05;
        if (moveDY < -0.05) moveDY = -0.05;
        if (moveDZ > 0.05) moveDZ = 0.05;
        if (moveDZ < -0.05) moveDZ = -0.05;

        currentAxisX += moveDX;
        currentAxisY += moveDY;
        currentAxisZ += moveDZ;
    } else {
        // Pure 1:1 Raw Data Bypass, completely disables all interpolation limits and sluggishness
        currentAxisX = targetAxisX;
        currentAxisY = targetAxisY;
        currentAxisZ = targetAxisZ;
    }

    // Cap axes to absolute maximum limits (avoids 10k jumps)
    if (currentAxisX > 2.0) currentAxisX = 2.0;
    if (currentAxisX < -2.0) currentAxisX = -2.0;
    if (currentAxisY > 2.0) currentAxisY = 2.0;
    if (currentAxisY < -2.0) currentAxisY = -2.0;
    if (currentAxisZ > 2.0) currentAxisZ = 2.0;
    if (currentAxisZ < -2.0) currentAxisZ = -2.0;

    // Throttle WebSocket messages to 30fps (33.3ms) to prevent OBS WebSocket TCP/choke jitter 
    // Sending 300 layer bounds adjustments per second overloaded the OBS scene graph and caused out-of-order execution bounces!
    // We re-evaluate lastParallaxUpdate carefully to ensure we only send when the websocket is likely clear.
    if (time - lastParallaxUpdate > 33.3) {
        // Internal DOM Parallax sync
        if (typeof window.getTheatreConfig === 'function') {
            const config = window.getTheatreConfig();
            if (config && config.parallax && config.parallax.enabled) {
                const intensity = config.parallax.intensity || 1.0;
                
                // 1. Sync Avatar DOM Parallax
                const avatarObj = config.avatar;
                if (avatarObj && avatarObj.parallaxDepth) {
                    const depth = parseFloat(avatarObj.parallaxDepth) / 100.0;
                    const shiftX = currentAxisX * depth * intensity * 150;
                    const shiftY = currentAxisY * depth * intensity * 150;
                    if (avatar) {
                        avatar.parallaxOffsetX = shiftX;
                        avatar.parallaxOffsetY = shiftY;
                    }
                }

                // 2. Sync Reactives (Fugi items) Parallax visually within the browser overlay
                // Find layer structural depth via the assigned reactives map
                if (config.fugiItems) {
                    config.fugiItems.forEach(fugi => {
                        let structuralDepth = 0;
                        let foundLayer = false;

                        // Check which Parallax layer this Reactive is actively assigned to
                        if (config.parallax.layers) {
                            config.parallax.layers.forEach((layer, index) => {
                                if (layer.reactives && layer.reactives.includes(fugi.id)) {
                                    structuralDepth = 2 - index; // Exact same math as OBS! Layer 3 (index 2) = 0 depth
                                    foundLayer = true;
                                }
                            });
                        }
                        
                        // Fallback to legacy individual parallaxDepth setting if not assigned to a system layer
                        if (!foundLayer && fugi.parallaxDepth !== undefined) {
                            structuralDepth = -1.0 * (parseFloat(fugi.parallaxDepth) / 100.0);
                        }

                        if (structuralDepth !== 0 || foundLayer) {
                            const zSpeed = config.parallax.zSpeed !== undefined ? parseFloat(config.parallax.zSpeed) : 0.1;
                            
                            // Exact math mirrored from OBS bridge
                            const shiftX = currentAxisX * structuralDepth * intensity * 150;
                            const shiftY = currentAxisY * structuralDepth * intensity * 150;
                            
                            let sizeScaleShift = currentAxisZ * (-structuralDepth) * intensity * zSpeed;
                            if (sizeScaleShift < -0.8) sizeScaleShift = -0.8;
                            const finalScale = 1.0 + sizeScaleShift;

                            const el = document.getElementById(fugi.id);
                            
                            // We use CSS transform so it stacks visually without modifying left/top variables that dragging uses.
                            if (el) { 
                                // To maintain proportional center point when scaling via CSS: transform-origin: center;
                                el.style.transformOrigin = 'center center';
                                el.style.transform = `translate(${shiftX}px, ${shiftY}px) scale(${finalScale})`;
                            }
                        } else {
                            // Purge transform if unassigned
                            const el = document.getElementById(fugi.id);
                            if (el && el.style.transform) {
                                el.style.transform = 'translate(0px, 0px) scale(1.0)';
                            }
                        }
                    });
                }
            }
        }

        // External OBS Parallax (Legacy/Optional)
        if (window.obsBridge && window.obsBridge.sendAxes && (Math.abs(currentAxisX - lastSentAxisX) > 0.0005 || Math.abs(currentAxisY - lastSentAxisY) > 0.0005 || Math.abs(currentAxisZ - lastSentAxisZ) > 0.0005)) {
            window.obsBridge.sendAxes(currentAxisX, currentAxisY, currentAxisZ);
            lastSentAxisX = currentAxisX;
            lastSentAxisY = currentAxisY;
            lastSentAxisZ = currentAxisZ;
        }
        lastParallaxUpdate = time;
    }

    // 3. DRAW GRAPHICS
    if (window._webglContext) {
        const gl = window._webglContext;
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
    ctx.clearRect(0, 0, width, height);

    // Draw Avatar first (so items format in front of or behind)
    if (avatar) {
        avatar.draw(ctx);
    }

    // Draw Throwables
    for (let i = 0; i < entities.length; i++) {
        entities[i].draw(ctx);
    }

    // Composite WebGL offscreen canvas onto the 2D canvas only if WebGL water/fire is active
    let hasWebGLStreams = false;
    for (let i = 0; i < entities.length; i++) {
        const ent = entities[i];
        if (
            (typeof WebGLWaterStream !== 'undefined' && ent instanceof WebGLWaterStream) ||
            (typeof WebGLFireStream !== 'undefined' && ent instanceof WebGLFireStream)
        ) {
            hasWebGLStreams = true;
            break;
        }
    }
    if (hasWebGLStreams && window._webglCanvas && window._webglContext) {
        ctx.drawImage(window._webglCanvas, 0, 0);
    }

    // Composite Three.js offscreen lightning canvas onto the 2D canvas (stretched from half-res to full screen size)
    if (window.ThreeLightningManager && window.ThreeLightningManager.initialized && window.ThreeLightningManager.selectedObjects.length > 0) {
        window.ThreeLightningManager.render();
        // ctx.drawImage(window.ThreeLightningManager.canvas, 0, 0, width, height); // Rendered natively via DOM overlay to prevent stalls
    }

    // --- DEBUG: Echo Layer 5 Coordinates ---
    try {
        const config = typeof window.getTheatreConfig === 'function' ? window.getTheatreConfig() : null;
        
        // Hide if preference is missing or disabled
        if (!window.preferencesManager || !window.preferencesManager.showEcho) {
            const overlay = document.getElementById('theatre-debug-overlay');
            if (overlay) overlay.style.display = 'none';
        } else {
            if (config && config.parallax && config.parallax.enabled && config.parallax.layers && config.parallax.targetScene) {
                const layer5Config = config.parallax.layers[4];
                if (layer5Config && layer5Config.name) {
                    const lName = layer5Config.name;
                    const cache = window.obsBridge && window.obsBridge.layerCache ? window.obsBridge.layerCache[config.parallax.targetScene] : null;
                    
                    if (cache && cache[lName]) {
                        const lCache = cache[lName];
                        const intensity = parseFloat(config.parallax.intensity || 1.0);
                        const structuralDepth = -2;
                        const finalX = lCache.baseX + (currentAxisX * structuralDepth * intensity * 150);
                        const finalY = lCache.baseY + (currentAxisY * structuralDepth * intensity * 150);

                        const avX = avatar ? avatar.x.toFixed(2) : 'N/A';
                        const avY = avatar ? avatar.y.toFixed(2) : 'N/A';
                        const resYOffset = avatar ? avatar.parallaxOffsetY.toFixed(2) : '0';

                        let debugDiv = document.getElementById('theatre-debug-overlay');
                        if (!debugDiv) {
                            debugDiv = document.createElement('div');
                            debugDiv.id = 'theatre-debug-overlay';
                            debugDiv.style.position = 'absolute';
                            debugDiv.style.top = '40px';
                            debugDiv.style.left = '20px';
                            debugDiv.style.zIndex = '9999';
                            debugDiv.style.color = '#fff';
                            debugDiv.style.fontFamily = "'Segoe UI', Arial, sans-serif";
                            debugDiv.style.fontWeight = 'bold';
                            debugDiv.style.fontSize = '16px';
                            debugDiv.style.textShadow = '2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
                            debugDiv.style.pointerEvents = 'auto'; // Make selectable
                            debugDiv.style.userSelect = 'text'; // Explicitly allow text selection
                            debugDiv.style.background = 'rgba(0, 0, 0, 0.4)';
                            debugDiv.style.padding = '10px';
                            debugDiv.style.borderRadius = '5px';
                            document.body.appendChild(debugDiv);
                        }

                        debugDiv.style.display = 'block';
                        debugDiv.innerHTML = `
                            <div style="color: #00ffcc;">Layer 5 (${lName}) Output:</div>
                            <div style="color: #00ffcc;">X: ${finalX.toFixed(2)} | Y: ${finalY.toFixed(2)}</div>
                            <div style="color: #ffcc00;">Base Cache: X:${lCache.baseX}, Y:${lCache.baseY}</div>
                            <div style="color: #ff6666;">App Tracking -> AxisX: ${currentAxisX.toFixed(4)}, AxisY: ${currentAxisY.toFixed(4)}, AxisZ: ${currentAxisZ.toFixed(4)}</div>
                            <div style="color: #cc66ff;">Avatar -> rawX: ${avX}, rawY: ${avY}, ParallaxOffsetY: ${resYOffset}</div>
                        `;
                    }
                }
            }
        }
    } catch (ignore) {}

    } catch(err) {
        console.error("[RUNTIME ERROR IN RENDER]:", err);
    }

    requestAnimationFrame(render);
}

// Start Lifecycle
init();

window.addEventListener('keydown', (e) => {
    // Simulate speaking on shift
    if (e.code === 'ShiftLeft' && avatar) {
        avatar.isSpeaking = true;
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'ShiftLeft' && avatar) {
        avatar.isSpeaking = false;
    }
});

// --- Base Avatar Dragging & Scaling Logic ---
let isDraggingAvatar = false;
let dragAvatarStartX = 0;
let dragAvatarStartY = 0;
let initialAvatarOffsetX = 0;
let initialAvatarOffsetY = 0;

// Parallax tracking variables
let targetAxisX = 0;
let targetAxisY = 0;
let targetAxisZ = 0;
let currentAxisX = 0;
let currentAxisY = 0;
let currentAxisZ = 0;
let lastParallaxUpdate = 0;
let lastSentAxisX = 0;
let lastSentAxisY = 0;
let lastSentAxisZ = 0;

let activeParallaxDriverId = null;
let parallaxBaselineX = null;
let parallaxBaselineY = null;
let parallaxBaselineZ = null;

let emaRawAxisX = null;
let emaRawAxisY = null;
let emaRawAxisZ = null;

// Expose baseline reset so OBS calibration can instantly snapshot the current physical position as 0,0
window.resetParallaxBaseline = () => {
    parallaxBaselineX = null;
    parallaxBaselineY = null;
    parallaxBaselineZ = null;
    currentAxisX = 0;
    currentAxisY = 0;
    currentAxisZ = 0;
    targetAxisX = 0;
    targetAxisY = 0;
    targetAxisZ = 0;
    let emaRawAxisX = null;
    let emaRawAxisY = null;
    let emaRawAxisZ = null;
    console.log("[App Parallax] Baseline explicitly reset to current position.");
};

window.addEventListener('mousedown', (e) => {
    // Prevent dragging if clicking into settings panel buttons or active overlay interactions
    if (e.target.closest('#settings-panel') || e.target.closest('#menu-toggle-btn') || e.target.closest('.media-source')) return;

    if (avatar) {
        // Approximate bounding box where the default static avatar sits (bottom center). 
        // We'll give it a generous 300x400 hit-box dynamically scaled so it roughly covers any silhouette.
        const hitWidth = 300 * avatar.baseScale; 
        const hitHeight = 400 * avatar.baseScale;
        
        // Avatar anchor point is at its exact bottom center
        let dx = e.clientX - avatar.x;
        let dy = e.clientY - avatar.y;

        // Is the mouse mathematically inside the rough rectangle hovering above avatar.x,y?
        if (Math.abs(dx) < hitWidth/2 && dy < 0 && dy > -hitHeight) {
            isDraggingAvatar = true;
            dragAvatarStartX = e.clientX;
            dragAvatarStartY = e.clientY;
            initialAvatarOffsetX = avatar.offsetX;
            initialAvatarOffsetY = avatar.offsetY;
        }
    }
});

window.addEventListener('mousemove', (e) => {

    // If the chosen driver is mouse pointer (or missing tracking data), update axes
    let isMouseParallax = false;
    if (typeof window.getTheatreConfig === 'function') {
        const config = window.getTheatreConfig();
        if (config && config.parallax && config.parallax.driverSource === 'mouse') {
            isMouseParallax = true;
        }
    }
    
    // Legacy fallback check (if camera driver is checked but has no data yet)
    if (!isMouseParallax) {
         // Rely entirely on CoM loop update above
    }

    if (isMouseParallax) {
        let mouseRawX = (e.clientX - window.innerWidth / 2) / (window.innerWidth / 2);
        let mouseRawY = (e.clientY - window.innerHeight / 2) / (window.innerHeight / 2);

        if (parallaxBaselineX === null) parallaxBaselineX = mouseRawX;
        if (parallaxBaselineY === null) parallaxBaselineY = mouseRawY;
        
        targetAxisX = mouseRawX - parallaxBaselineX;
        targetAxisY = mouseRawY - parallaxBaselineY;
    }

    if (isDraggingAvatar && avatar) {
        avatar.offsetX = initialAvatarOffsetX + (e.clientX - dragAvatarStartX);
        avatar.offsetY = initialAvatarOffsetY + (e.clientY - dragAvatarStartY);
    }
});

window.addEventListener('mouseup', () => {

    if (isDraggingAvatar && avatar) {
        isDraggingAvatar = false;
        
        // Persist avatar layout globally
        requestAnimationFrame(() => {
            const configStr = localStorage.getItem('theatre_config');
            if (configStr) {
                let conf = JSON.parse(configStr);
                conf.avatarOffsetX = avatar.offsetX;
                conf.avatarOffsetY = avatar.offsetY;
                conf.avatarBaseScale = avatar.baseScale;
                localStorage.setItem('theatre_config', JSON.stringify(conf));
            }
        });
    }
});

window.addEventListener('wheel', (e) => {
    // Only zoom avatar if hovering directly over canvas gap (not UI windows)
    if (e.target.closest('#settings-panel') || e.target.closest('#menu-toggle-btn') || e.target.closest('.media-source')) return;
    
    if (avatar) {
        if (e.deltaY < 0) {
            avatar.baseScale += 0.05; // Scroll Up -> Grow
        } else {
            avatar.baseScale -= 0.05; // Scroll Down -> Shrink
            if (avatar.baseScale < 0.1) avatar.baseScale = 0.1;
        }
        
        // Persist global scale
        const configStr = localStorage.getItem('theatre_config');
        if (configStr) {
            let conf = JSON.parse(configStr);
            conf.avatarBaseScale = avatar.baseScale;
            localStorage.setItem('theatre_config', JSON.stringify(conf));
        }
    }
});

