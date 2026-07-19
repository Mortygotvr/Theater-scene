class WebGLWaterStream {
    constructor(startX, startY, config = {}) {
        this.startX = startX;
        this.startY = startY;
        this.vx = config.vx || 0;
        this.vy = config.vy || 0;
        
        this.colorR = config.colorR !== undefined ? parseFloat(config.colorR) : 0;
        this.colorG = config.colorG !== undefined ? parseFloat(config.colorG) : 170;
        this.colorB = config.colorB !== undefined ? parseFloat(config.colorB) : 255;
        this.colorA = config.colorA !== undefined ? parseFloat(config.colorA) : 0.95;

        if (config.color && config.colorR === undefined) {
            const parsed = this.parseColor(config.color);
            this.colorR = Math.round(parsed[0] * 255);
            this.colorG = Math.round(parsed[1] * 255);
            this.colorB = Math.round(parsed[2] * 255);
        }

        this.colorRgb = [this.colorR / 255, this.colorG / 255, this.colorB / 255];
        
        this.color2R = config.color2R !== undefined ? parseFloat(config.color2R) : 100;
        this.color2G = config.color2G !== undefined ? parseFloat(config.color2G) : 210;
        this.color2B = config.color2B !== undefined ? parseFloat(config.color2B) : 255;
        this.color2A = config.color2A !== undefined ? parseFloat(config.color2A) : 0.85;
        this.color2Rgb = [this.color2R / 255, this.color2G / 255, this.color2B / 255];
        
        this.borderThickness = config.borderThickness !== undefined ? parseFloat(config.borderThickness) : 0.06;
        this.fluidCount = config.fluidCount !== undefined ? parseInt(config.fluidCount) : 150;
        this.fluidRadius = config.fluidRadius !== undefined ? parseFloat(config.fluidRadius) : 15;
        this.fluidViscosity = config.fluidViscosity !== undefined ? parseFloat(config.fluidViscosity) : 0.5;
        this.fluidDuration = config.fluidDuration !== undefined ? parseFloat(config.fluidDuration) : 6000;
        this.fluidGravity = config.fluidGravity !== undefined ? parseFloat(config.fluidGravity) : 0.8;
        this.fluidWidth = config.fluidWidth !== undefined ? parseFloat(config.fluidWidth) : 30;
        
        const shrinkRate = config.dripShrink !== undefined ? parseFloat(config.dripShrink) : 16;
        this.dripShrinkMultiplier = 1.0 - (shrinkRate / 2000.0);

        this.dripThroughPercent = config.dripThroughPercent !== undefined ? parseFloat(config.dripThroughPercent) : 50;

        this.enableOutline = config.enableOutline !== undefined ? !!config.enableOutline : true;

        this.streamMode = config.streamMode || 'grid';
        this.spawnPoints = config.spawnPoints || ['tc'];
        this.targetElement = config.targetElement || null;
        this.targetName = config.targetName || 'avatar';
        this.targetRect = config.targetRect || null;
        this.targetOffsetX = config.targetOffsetX || 0;
        this.targetOffsetY = config.targetOffsetY || 0;
        this.targetWX = config.targetWX || (window.innerWidth / 2);
        this.targetWY = config.targetWY || (window.innerHeight / 2);

        this.dead = false;
        this.startTime = Date.now();
        this.particles = [];
        this.emittedCount = 0;

        // Calculate particle count to emit per millisecond
        this.emitRateMs = this.fluidCount / this.fluidDuration;

        WebGLWaterStream.initGlobalWebGL();
    }

    parseColor(hex) {
        if (hex.startsWith('#')) {
            hex = hex.slice(1);
        }
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        return [isNaN(r) ? 0.0 : r, isNaN(g) ? 0.66 : g, isNaN(b) ? 1.0 : b];
    }

    static initGlobalWebGL() {
        const gl = window._webglContext;
        if (!gl) return;
        if (window._webglResourcesInitialized) return;

        // Compile Shader Helper
        function compileShader(gl, src, type) {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.error("Shader compilation failed:", gl.getShaderInfoLog(s));
            }
            return s;
        }

        // Link Program Helper
        function linkProgram(gl, vs, fs) {
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                console.error("Program linking failed:", gl.getProgramInfoLog(prog));
            }
            return prog;
        }

        // Pass 1: Render density + particle color attributes to FBO
        const pass1VS = `
            attribute vec2 a_position;
            attribute float a_size;
            attribute vec3 a_color;
            varying vec3 v_color;
            uniform vec2 u_resolution;
            void main() {
                vec2 zeroToOne = a_position / u_resolution;
                vec2 zeroToTwo = zeroToOne * 2.0;
                vec2 clipSpace = zeroToTwo - 1.0;
                gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
                gl_PointSize = a_size;
                v_color = a_color;
            }
        `;

        const pass1FS = `
            precision mediump float;
            varying vec3 v_color;
            void main() {
                float dist = length(gl_PointCoord - vec2(0.5));
                if (dist > 0.5) discard;
                float density = (1.0 - dist * 2.0);
                density = density * density;
                gl_FragColor = vec4(v_color * density, density);
            }
        `;

        // Pass 2: Screen space metaball composite
        const pass2VS = `
            attribute vec2 a_position;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0, 1);
                v_texCoord = a_position * 0.5 + 0.5;
            }
        `;

        const pass2FS = `
            precision mediump float;
            varying vec2 v_texCoord;
            uniform sampler2D u_texture;
            uniform vec2 u_resolution;
            uniform float u_time;
            uniform float u_borderThickness;
            uniform float u_alpha;
            uniform float u_color2Alpha;
            uniform float u_enableOutline;
            uniform vec3 u_color2;
            
            void main() {
                float outerThreshold = 0.20;
                float innerThreshold = outerThreshold + u_borderThickness;
                
                vec2 uv = v_texCoord;
                vec4 texColor = texture2D(u_texture, uv);
                float density = texColor.a;
                
                if (density < (u_enableOutline > 0.5 ? outerThreshold : innerThreshold)) discard;
                
                if (u_enableOutline > 0.5 && density < innerThreshold) {
                    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
                    return;
                }
                
                vec2 texelSize = vec2(1.0) / u_resolution;
                float dL = texture2D(u_texture, uv - vec2(texelSize.x * 2.0, 0.0)).a;
                float dR = texture2D(u_texture, uv + vec2(texelSize.x * 2.0, 0.0)).a;
                float dT = texture2D(u_texture, uv - vec2(0.0, texelSize.y * 2.0)).a;
                float dB = texture2D(u_texture, uv + vec2(0.0, texelSize.y * 2.0)).a;
                
                vec3 normal = normalize(vec3((dL - dR) * 2.0, (dT - dB) * 2.0, 0.5));
                
                vec3 baseWaterColor = texColor.rgb / max(density, 0.001);
                
                float celColor = step(0.48, density);
                vec3 color = mix(baseWaterColor, u_color2, celColor);
                
                vec3 lightDir = normalize(vec3(-0.45, 0.65, 0.8));
                vec3 viewDir = vec3(0.0, 0.0, 1.0);
                vec3 halfDir = normalize(lightDir + viewDir);
                float spec = pow(max(dot(normal, halfDir), 0.0), 40.0);
                float specVal = step(0.65, spec);
                color = mix(color, vec3(1.0), specVal * 0.80);
                
                float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
                color = mix(color, vec3(1.0), fresnel * 0.25);
                
                float alpha = mix(u_alpha, u_color2Alpha, celColor);
                gl_FragColor = vec4(color, alpha);
            }
        `;

        const p1VS = compileShader(gl, pass1VS, gl.VERTEX_SHADER);
        const p1FS = compileShader(gl, pass1FS, gl.FRAGMENT_SHADER);
        window._webglProgram1 = linkProgram(gl, p1VS, p1FS);

        const p2VS = compileShader(gl, pass2VS, gl.VERTEX_SHADER);
        const p2FS = compileShader(gl, pass2FS, gl.FRAGMENT_SHADER);
        window._webglProgram2 = linkProgram(gl, p2VS, p2FS);

        // Framebuffer Object (FBO) Setup
        window._webglFboWidth = 512;
        window._webglFboHeight = 512;
        window._webglTargetTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, window._webglTargetTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, window._webglFboWidth, window._webglFboHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        window._webglFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, window._webglFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, window._webglTargetTexture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Static Buffers
        window._webglPositionBuffer = gl.createBuffer();
        window._webglSizeBuffer = gl.createBuffer();
        window._webglColorBuffer = gl.createBuffer();
        
        window._webglQuadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglQuadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,   1, -1,  -1,  1,
            -1,  1,   1, -1,   1,  1
        ]), gl.STATIC_DRAW);

        window._webglResourcesInitialized = true;
    }

    emitParticle(canvasWidth, canvasHeight, frameFraction = 0) {
        let px, py, pvx, pvy;

        // Resolve target coordinates using canvas-space world coordinates
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

        const gravityVal = this.fluidGravity;

        if (this.streamMode === 'top') {
            // Pours straight down relative to the target, tracking it horizontally
            let xLean = 0;
            if (this.spawnPoints && this.spawnPoints.length > 0) {
                const choice = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
                if (choice === 'ml' || choice === 'tl' || choice === 'bl') {
                    xLean = -(60 + Math.random() * 60);
                } else if (choice === 'mr' || choice === 'tr' || choice === 'br') {
                    xLean = 60 + Math.random() * 60;
                }
            }
            px = targetX + xLean + (Math.random() * this.fluidWidth - this.fluidWidth / 2);
            py = -20;
            pvx = (Math.random() - 0.5) * 0.4;
            pvy = 3.0 + Math.random() * 1.0;
        } else {
            // Aim at the target from the dynamically chosen starting position
            const dx = targetX - this.startX;
            const dy = targetY - this.startY;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1.0;
            
            // Speed of the stream
            const speed = 18.0 * (this.fluidViscosity * 2.0);
            
            // Calculate travel time to target in frames: distance / step distance
            const stepDist = speed * this.fluidViscosity;
            const timeToHit = dist / Math.max(0.1, stepDist);
            
            // Calculate vertical drop due to gravity during flight
            const gravityDrop = 0.5 * gravityVal * this.fluidViscosity * timeToHit * timeToHit;
            
            // Aim higher to compensate for gravity drop
            const adjustedTargetY = targetY - gravityDrop;
            const adjDy = adjustedTargetY - this.startY;
            const angle = Math.atan2(adjDy, dx) + (Math.random() - 0.5) * 0.04;
            
            pvx = Math.cos(angle) * speed;
            pvy = Math.sin(angle) * speed;

            px = this.startX + (Math.random() - 0.5) * this.fluidWidth;
            py = this.startY;
        }

        // Apply sub-frame physics interpolation
        const dt = frameFraction; // 0.0 to 1.0 representing when in the frame step this was spawned
        px = px + pvx * this.fluidViscosity * dt;
        py = py + pvy * this.fluidViscosity * dt + 0.5 * gravityVal * this.fluidViscosity * dt * dt;
        pvy = pvy + gravityVal * this.fluidViscosity * dt;

        const isFoam = Math.random() < 0.2;
        let size, color, decay;

        if (isFoam) {
            size = this.fluidRadius * (0.2 + Math.random() * 0.3);
            color = [0.95, 0.98, 1.0];
            decay = 0.006 + Math.random() * 0.01;
        } else {
            size = this.fluidRadius * (0.75 + Math.random() * 0.4);
            color = [...this.colorRgb];
            decay = 0.0015 + Math.random() * 0.003;
        }

        const particleLife = 1.0 - (decay * dt);

        this.particles.push({
            x: px,
            y: py,
            vx: pvx,
            vy: pvy,
            size: size,
            color: color,
            isFoam: isFoam,
            decay: decay,
            life: Math.max(0.01, particleLife),
            seed: Math.random() * 100,
            wobbleSpeed: Math.random(),
            isDripping: false
        });
    }

    update(canvasWidth, canvasHeight) {
        if (this.dead) return;

        const elapsed = Date.now() - this.startTime;

        // 1. Emission
        if (elapsed < this.fluidDuration) {
            const targetEmitted = Math.min(this.fluidCount, Math.floor(elapsed * this.emitRateMs));
            const toEmit = targetEmitted - this.emittedCount;
            if (toEmit > 0) {
                let currentTotal = 0;
                if (typeof entities !== 'undefined') {
                    for (const ent of entities) {
                        if (ent.particles) currentTotal += ent.particles.length;
                    }
                }
                if (currentTotal < 800) {
                    for (let i = 0; i < toEmit; i++) {
                        const frameFraction = (i + 0.5) / toEmit;
                        this.emitParticle(canvasWidth, canvasHeight, frameFraction);
                        this.emittedCount++;
                    }
                } else {
                    this.emittedCount += toEmit;
                }
            }
        }

        // 2. Physics Update
        const gravityVal = this.fluidGravity;
        
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            
            let onTarget = false;
            if (window.targetUI && this.targetName) {
                onTarget = window.targetUI.isHit(p.x, p.y, this.targetName);
            }

            if (onTarget) {
                p.isDripping = true;
            }

            if (p.isDripping) {
                if (!p.dripBehavior) {
                    p.dripBehavior = Math.random() * 100 < this.dripThroughPercent ? 'through' : 'around';
                }

                // Slow drip physics on mask
                p.vy = (0.25 + (p.wobbleSpeed || 0.1) * 0.25) * this.fluidViscosity;
                
                let slideBias = 0;
                if (p.dripBehavior === 'around') {
                    if (window.targetUI) {
                        const bounds = window.targetUI.getTargetBounds(this.targetName);
                        if (bounds) {
                            const [bx, by, bw, bh] = bounds;
                            const centerX = bx + bw / 2;
                            slideBias = p.x < centerX ? -0.45 : 0.45;
                        }
                    }
                }
                
                p.vx = slideBias * this.fluidViscosity;
                p.x += p.vx;
                p.y += p.vy;
                
                // Slow decay so drips trail down longer
                p.life -= p.decay * 0.4;
                
                // Gradually shrink to simulate leaving water behind
                p.size *= this.dripShrinkMultiplier;
                
                // Check if we slid off the target entirely
                const stillOnTarget = window.targetUI ? window.targetUI.isHit(p.x, p.y, this.targetName) : false;
                if (!stillOnTarget) {
                    p.isDripping = false;
                }
            } else {
                // Regular air physics
                p.vy += gravityVal * this.fluidViscosity;
                p.x += p.vx * this.fluidViscosity;
                p.y += p.vy * this.fluidViscosity;
                
                p.life -= p.decay;
            }

            // Floor collision
            const floorY = canvasHeight - 50;
            const useFloor = (window.preferencesManager && window.preferencesManager.floorEnabled) !== false;
            
            if (useFloor && p.y > floorY) {
                p.y = floorY;
                p.vy = -Math.abs(p.vy) * 0.25;
                p.vx *= 0.8;
            }

            // Boundary clean
            if (p.life <= 0 || p.size < 1.0 || p.x < -100 || p.x > canvasWidth + 100 || p.y > canvasHeight + 100) {
                this.particles.splice(i, 1);
            }
        }

        // 3. Check if dead
        if (elapsed >= this.fluidDuration && this.particles.length === 0) {
            this.dead = true;
        }
    }

    draw(ctx) {
        const gl = window._webglContext;
        if (!gl) return;

        // Collect all active streams from the global entities array
        const allStreams = (typeof entities !== 'undefined') ? entities.filter(e => e instanceof WebGLWaterStream) : [this];
        if (allStreams.length > 0 && this !== allStreams[0]) {
            return; // Only the first stream draws to avoid duplicate composite passes
        }

        const combinedParticles = [];
        for (let s = 0; s < allStreams.length; s++) {
            const streamInstance = allStreams[s];
            for (let i = 0; i < streamInstance.particles.length; i++) {
                const p = streamInstance.particles[i];
                p.parentStream = streamInstance;
                combinedParticles.push(p);
            }
        }

        if (combinedParticles.length === 0) return;

        const canvasWidth = gl.canvas.width;
        const canvasHeight = gl.canvas.height;

        // 1. UNBIND texture from Unit 0 to prevent FBO feedback loops
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Resize FBO texture if size changed
        const targetW = Math.max(256, Math.round(canvasWidth / 2.0));
        const targetH = Math.max(256, Math.round(canvasHeight / 2.0));
        if (window._webglFboWidth !== targetW || window._webglFboHeight !== targetH) {
            window._webglFboWidth = targetW;
            window._webglFboHeight = targetH;
            gl.bindTexture(gl.TEXTURE_2D, window._webglTargetTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, window._webglFboWidth, window._webglFboHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }

        // --- PASS 1: Render particles to FBO ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, window._webglFbo);
        gl.viewport(0, 0, window._webglFboWidth, window._webglFboHeight);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(window._webglProgram1);

        const uRes1 = gl.getUniformLocation(window._webglProgram1, 'u_resolution');
        gl.uniform2f(uRes1, canvasWidth, canvasHeight);

        // Collect buffers
        const positions = new Float32Array(combinedParticles.length * 2);
        const sizes = new Float32Array(combinedParticles.length);
        const colors = new Float32Array(combinedParticles.length * 3);
        
        for (let i = 0; i < combinedParticles.length; i++) {
            const p = combinedParticles[i];
            positions[i * 2] = p.x;
            positions[i * 2 + 1] = p.y;
            sizes[i] = p.size * Math.sqrt(p.life);
            
            const parent = p.parentStream || this;
            if (!p.isFoam) {
                p.color[0] = parent.colorRgb[0];
                p.color[1] = parent.colorRgb[1];
                p.color[2] = parent.colorRgb[2];
            }
            colors[i * 3] = p.color[0];
            colors[i * 3 + 1] = p.color[1];
            colors[i * 3 + 2] = p.color[2];
        }

        // Bind position
        const posLoc = gl.getAttribLocation(window._webglProgram1, 'a_position');
        if (posLoc !== -1) {
            gl.enableVertexAttribArray(posLoc);
            gl.bindBuffer(gl.ARRAY_BUFFER, window._webglPositionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        }

        // Bind size
        const sizeLoc = gl.getAttribLocation(window._webglProgram1, 'a_size');
        if (sizeLoc !== -1) {
            gl.enableVertexAttribArray(sizeLoc);
            gl.bindBuffer(gl.ARRAY_BUFFER, window._webglSizeBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, sizes, gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, 0, 0);
        }

        // Bind color
        const colorLoc = gl.getAttribLocation(window._webglProgram1, 'a_color');
        if (colorLoc !== -1) {
            gl.enableVertexAttribArray(colorLoc);
            gl.bindBuffer(gl.ARRAY_BUFFER, window._webglColorBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 0, 0);
        }

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // Additive blending for metaball density

        gl.drawArrays(gl.POINTS, 0, combinedParticles.length);

        // Cleanup attributes for Pass 1
        if (posLoc !== -1) gl.disableVertexAttribArray(posLoc);
        if (sizeLoc !== -1) gl.disableVertexAttribArray(sizeLoc);
        if (colorLoc !== -1) gl.disableVertexAttribArray(colorLoc);

        // --- PASS 2: Render screen composite ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvasWidth, canvasHeight);

        gl.useProgram(window._webglProgram2);

        // Bind composite uniforms
        const uRes2 = gl.getUniformLocation(window._webglProgram2, 'u_resolution');
        gl.uniform2f(uRes2, canvasWidth, canvasHeight);
        
        const elapsedTime = (Date.now() - this.startTime) * 0.001;
        const uTime = gl.getUniformLocation(window._webglProgram2, 'u_time');
        gl.uniform1f(uTime, elapsedTime);
        
        const uBorder = gl.getUniformLocation(window._webglProgram2, 'u_borderThickness');
        gl.uniform1f(uBorder, this.borderThickness);

        const uAlpha = gl.getUniformLocation(window._webglProgram2, 'u_alpha');
        gl.uniform1f(uAlpha, this.colorA);

        const parentStream = allStreams[0] || this;
        const uEnableOutline = gl.getUniformLocation(window._webglProgram2, 'u_enableOutline');
        gl.uniform1f(uEnableOutline, parentStream.enableOutline ? 1.0 : 0.0);

        const uColor2 = gl.getUniformLocation(window._webglProgram2, 'u_color2');
        gl.uniform3fv(uColor2, parentStream.color2Rgb);

        const uColor2Alpha = gl.getUniformLocation(window._webglProgram2, 'u_color2Alpha');
        gl.uniform1f(uColor2Alpha, parentStream.color2A !== undefined ? parentStream.color2A : 0.85);

        // Bind FBO texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, window._webglTargetTexture);
        const uTexLoc = gl.getUniformLocation(window._webglProgram2, 'u_texture');
        gl.uniform1i(uTexLoc, 0);

        const posLoc2 = gl.getAttribLocation(window._webglProgram2, 'a_position');
        if (posLoc2 !== -1) {
            gl.enableVertexAttribArray(posLoc2);
            gl.bindBuffer(gl.ARRAY_BUFFER, window._webglQuadBuffer);
            gl.vertexAttribPointer(posLoc2, 2, gl.FLOAT, false, 0, 0);
        }

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Cleanup attributes for Pass 2
        if (posLoc2 !== -1) gl.disableVertexAttribArray(posLoc2);
    }

    destroy() {
        this.particles = [];
    }
}
