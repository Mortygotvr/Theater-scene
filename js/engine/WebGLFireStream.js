class WebGLFireStream {
    constructor(startX, startY, config = {}) {
        this.startX = startX;
        this.startY = startY;
        
        this.colorR = config.colorR !== undefined ? parseFloat(config.colorR) : 255;
        this.colorG = config.colorG !== undefined ? parseFloat(config.colorG) : 80;
        this.colorB = config.colorB !== undefined ? parseFloat(config.colorB) : 0;
        this.colorA = config.colorA !== undefined ? parseFloat(config.colorA) : 0.95;
        this.colorRgb = [this.colorR / 255, this.colorG / 255, this.colorB / 255];
        
        const r = this.colorRgb[0];
        const g = this.colorRgb[1];
        const b = this.colorRgb[2];

        // Derive hotter core (yellow-white glow)
        const coreR = Math.min(1.0, r + (1.0 - r) * 0.7);
        const coreG = Math.min(1.0, g + (1.0 - g) * 0.7);
        const coreB = Math.min(1.0, b + (1.0 - b) * 0.4);
        this.color2Rgb = [coreR, coreG, coreB];

        // Derive richer, darker outline
        const outlineR = r * 0.9;
        const outlineG = g * 0.3;
        const outlineB = b * 0.15;
        this.colorOutlineRgb = [outlineR, outlineG, outlineB];
        
        this.borderThickness = config.borderThickness !== undefined ? parseFloat(config.borderThickness) : 0.08;
        this.fluidDuration = config.fluidDuration !== undefined ? parseFloat(config.fluidDuration) : 3000;
        this.fluidWidth = config.fluidWidth !== undefined ? parseFloat(config.fluidWidth) : 200; // Flame width
        this.enableOutline = config.enableOutline !== undefined ? !!config.enableOutline : true;
        
        this.fluidRadius = config.fluidRadius !== undefined ? parseFloat(config.fluidRadius) : 16;
        this.fluidViscosity = config.fluidViscosity !== undefined ? parseFloat(config.fluidViscosity) : 0.6;
        this.fluidGravity = config.fluidGravity !== undefined ? parseFloat(config.fluidGravity) : -0.4;
        this.dripShrink = config.dripShrink !== undefined ? parseFloat(config.dripShrink) : 25;
        this.fluidCount = config.fluidCount !== undefined ? parseInt(config.fluidCount) : 400;

        this.streamMode = config.streamMode || 'grid';
        this.spawnPoints = config.spawnPoints || ['bc'];
        this.targetElement = config.targetElement || null;
        this.targetName = config.targetName || 'avatar';
        this.targetRect = config.targetRect || null;
        this.targetOffsetX = config.targetOffsetX || 0;
        this.targetOffsetY = config.targetOffsetY || 0;
        this.targetWX = config.targetWX || (window.innerWidth / 2);
        this.targetWY = config.targetWY || (window.innerHeight / 2);

        this.dead = false;
        this.particles = [];
        this.emittedCount = 0;
        this.emitRateMs = this.fluidCount / this.fluidDuration;

        // Pre-warm the particle simulation if it rises straight up
        if (this.streamMode === 'top') {
            const prewarmFrames = 72; // ~1.2s at 60 FPS
            const frameTime = 16.67;
            for (let i = 0; i < prewarmFrames; i++) {
                this.tickPhysics(i * frameTime);
            }
            this.startTime = Date.now() - (prewarmFrames * frameTime);
        } else {
            this.startTime = Date.now();
        }

        WebGLFireStream.initGlobalWebGL();
    }

    static initGlobalWebGL() {
        const gl = window._webglContext;
        if (!gl) return;
        if (window._webglFireResourcesInitialized) return;

        // Compile Shader Helper
        function compileShader(gl, src, type) {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.error("Fire Shader compilation failed:", gl.getShaderInfoLog(s));
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
                console.error("Fire Program linking failed:", gl.getProgramInfoLog(prog));
            }
            return prog;
        }

        const vsSource = `
            attribute vec2 a_position;
            attribute float a_size;
            attribute float a_life;
            attribute float a_isSpark;
            attribute float a_angle;
            varying float v_life;
            varying float v_isSpark;
            varying float v_angle;
            uniform vec2 u_resolution;
            void main() {
                vec2 zeroToOne = a_position / u_resolution;
                vec2 zeroToTwo = zeroToOne * 2.0;
                vec2 clipSpace = zeroToTwo - 1.0;
                gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
                gl_PointSize = a_size;
                v_life = a_life;
                v_isSpark = a_isSpark;
                v_angle = a_angle;
            }
        `;

        const fsSource = `
            precision mediump float;
            varying float v_life;
            varying float v_isSpark;
            varying float v_angle;
            uniform float u_borderThickness;
            uniform float u_enableOutline;
            uniform float u_alpha;
            uniform vec3 u_color;
            uniform vec3 u_color2;
            uniform vec3 u_colorOutline;
            uniform sampler2D u_texture;
            
            void main() {
                vec2 uv = gl_PointCoord - vec2(0.5);
                
                // Rotate coordinates for the teardrop texture shape (only flame cells, not sparks)
                if (v_isSpark < 0.5) {
                    float cosA = cos(v_angle);
                    float sinA = sin(v_angle);
                    uv = vec2(uv.x * cosA - uv.y * sinA, uv.x * sinA + uv.y * cosA);
                }
                
                vec2 texCoord = uv + vec2(0.5);
                if (texCoord.x < 0.0 || texCoord.x > 1.0 || texCoord.y < 0.0 || texCoord.y > 1.0) {
                    discard;
                }
                
                vec4 texColor = texture2D(u_texture, texCoord);
                if (texColor.a < 0.01) discard;
                
                if (v_isSpark > 0.5) {
                    // Sparks are small bright circles
                    float dist = distance(gl_PointCoord, vec2(0.5));
                    if (dist > 0.5) discard;
                    float alpha = smoothstep(0.5, 0.2, dist) * u_alpha * v_life;
                    gl_FragColor = vec4(u_color2, alpha);
                } else {
                    float density = texColor.a;
                    float outerThreshold = 0.15;
                    float innerThreshold = outerThreshold + u_borderThickness;
                    
                    if (u_enableOutline > 0.5) {
                        if (density < outerThreshold) discard;
                        
                        vec3 finalColor = vec3(0.0);
                        float alpha = u_alpha * min(1.0, v_life * 3.0);
                        
                        if (density < innerThreshold) {
                            finalColor = u_colorOutline;
                        } else {
                            float t = (density - innerThreshold) / (1.0 - innerThreshold);
                            finalColor = mix(u_color, u_color2, smoothstep(0.0, 0.8, t));
                            float glow = smoothstep(0.7, 1.0, t);
                            finalColor = mix(finalColor, vec3(1.0, 1.0, 0.95), glow * 0.45);
                        }
                        gl_FragColor = vec4(finalColor, alpha);
                    } else {
                        // Soft glowing particle for additive blending - mix based on alpha density
                        vec3 finalColor = mix(u_color, u_color2, smoothstep(0.15, 0.75, texColor.a));
                        float glow = smoothstep(0.7, 1.0, texColor.a);
                        finalColor = mix(finalColor, vec3(1.0, 1.0, 0.95), glow * 0.45);
                        gl_FragColor = vec4(finalColor, texColor.a * u_alpha * v_life);
                    }
                }
            }
        `;

        const vs = compileShader(gl, vsSource, gl.VERTEX_SHADER);
        const fs = compileShader(gl, fsSource, gl.FRAGMENT_SHADER);
        window._webglFireProgram = linkProgram(gl, vs, fs);

        window._webglFirePositionBuffer = gl.createBuffer();
        window._webglFireSizeBuffer = gl.createBuffer();
        window._webglFireLifeBuffer = gl.createBuffer();
        window._webglFireSparkBuffer = gl.createBuffer();
        window._webglFireAngleBuffer = gl.createBuffer();

        // Generate the soft flame-lick wisp texture dynamically on an offscreen canvas
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 64;
        tempCanvas.height = 64;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.clearRect(0, 0, 64, 64);
        
        // Use a blur filter for soft organic edges
        tempCtx.filter = 'blur(2.5px)';
        
        // Draw an organic flame wisp path fitting inside a 44px central circle (radius 22)
        tempCtx.beginPath();
        tempCtx.moveTo(32, 12); // Tip of flame wisp
        tempCtx.quadraticCurveTo(46, 24, 40, 38); // Upper right curve
        tempCtx.quadraticCurveTo(36, 50, 32, 52); // Lower right curve (bottom)
        tempCtx.quadraticCurveTo(20, 50, 20, 38); // Lower left curve
        tempCtx.quadraticCurveTo(24, 24, 32, 12); // Upper left curve
        tempCtx.closePath();

        // Create linear gradient along the length of the wisp (bottom to top)
        const grad = tempCtx.createLinearGradient(32, 52, 32, 12);
        grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)'); // Opaque hot white core at bottom
        grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.85)'); 
        grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.4)'); 
        grad.addColorStop(0.85, 'rgba(255, 255, 255, 0.1)'); 
        grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)'); // Transparent tip
        
        tempCtx.fillStyle = grad;
        tempCtx.fill();

        window._webglFireTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, window._webglFireTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tempCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        window._webglFireResourcesInitialized = true;
    }

    tickPhysics(elapsed) {
        // 1. Resolve emitter position (fly from grid to target)
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

        let emitterX = targetX;
        let emitterY = targetY + (this.targetRect ? this.targetRect.height * 0.5 : 50);

        const flightTime = Math.min(800, this.fluidDuration * 0.25);
        if (this.streamMode === 'grid' && elapsed < flightTime) {
            const t = elapsed / flightTime;
            const easeT = t * t * (3.0 - 2.0 * t);
            emitterX = this.startX * (1.0 - easeT) + targetX * easeT;
            emitterY = this.startY * (1.0 - easeT) + (targetY + (this.targetRect ? this.targetRect.height * 0.5 : 50)) * easeT;
        }

        // 2. Emission
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
                        const spreadX = (Math.random() - 0.5) * this.fluidWidth;
                        const px = emitterX + spreadX;
                        const py = emitterY + (Math.random() - 0.5) * 10;
                        
                        // Upward velocity with slight horizontal spread
                        const pvx = (Math.random() - 0.5) * this.fluidViscosity * 3.0;
                        const pvy = -1.0 * (1.2 + Math.random() * 1.5) * this.fluidViscosity * 4.0;
                        
                        const isSpark = Math.random() < 0.18;
                        let size, decay, angle;
                        if (isSpark) {
                            size = this.fluidRadius * (0.15 + Math.random() * 0.25);
                            decay = (0.015 + Math.random() * 0.02) * (this.dripShrink / 25.0);
                            angle = 0;
                        } else {
                            size = this.fluidRadius * (0.8 + Math.random() * 0.6);
                            decay = (0.008 + Math.random() * 0.012) * (this.dripShrink / 25.0);
                            angle = (Math.random() - 0.5) * 0.5; // initial tilt
                        }
                        
                        this.particles.push({
                            x: px,
                            y: py,
                            vx: pvx,
                            vy: pvy,
                            size: size,
                            decay: decay,
                            life: 1.0,
                            isSpark: isSpark,
                            angle: angle,
                            swayOffset: Math.random() * 100 // unique phase offset for sway animation
                        });
                        
                        this.emittedCount++;
                    }
                } else {
                    this.emittedCount += toEmit;
                }
            }
        }

        // 3. Update active particles
        const gravityVal = this.fluidGravity; // e.g. -0.4 (rising)
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            
            // Apply upward buoyancy from negative gravity
            p.vy += gravityVal * 0.15;
            
            // Add horizontal sway / wind turbulence
            p.vx += Math.sin(elapsed * 0.006 + p.x * 0.05) * 0.08;
            
            // Move particle (viscosity scales speed)
            p.x += p.vx * this.fluidViscosity;
            p.y += p.vy * this.fluidViscosity;
            
            if (p.isSpark) {
                p.vx += (Math.random() - 0.5) * 0.5;
            } else {
                // Align wisp angle with velocity direction + organic wiggle sway
                p.angle = Math.atan2(p.vx, -p.vy) + Math.sin(elapsed * 0.01 + p.swayOffset) * 0.25;
            }
            
            // Decay life
            p.life -= p.decay * this.fluidViscosity;
            
            // Remove if dead
            if (p.life <= 0 || p.size < 1.0) {
                this.particles.splice(i, 1);
            }
        }
    }

    update(canvasWidth, canvasHeight) {
        if (this.dead) return;

        const elapsed = Date.now() - this.startTime;
        this.tickPhysics(elapsed);

        // 4. Check if finished
        if (elapsed >= this.fluidDuration && this.particles.length === 0) {
            this.dead = true;
        }
    }

    draw(ctx) {
        if (this.dead) return;

        const gl = window._webglContext;
        if (!gl) return;

        if (this.particles.length === 0) return;

        const canvasWidth = gl.canvas.width;
        const canvasHeight = gl.canvas.height;

        gl.viewport(0, 0, canvasWidth, canvasHeight);
        gl.useProgram(window._webglFireProgram);

        // Prepare arrays
        const positions = new Float32Array(this.particles.length * 2);
        const sizes = new Float32Array(this.particles.length);
        const lives = new Float32Array(this.particles.length);
        const sparks = new Float32Array(this.particles.length);
        const angles = new Float32Array(this.particles.length);
        
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            positions[i * 2] = p.x;
            positions[i * 2 + 1] = p.y;
            // Particles shrink over lifetime, but stay thick enough at the top to prevent sharp cone
            sizes[i] = p.size * (0.35 + 0.65 * Math.sqrt(p.life));
            lives[i] = p.life;
            sparks[i] = p.isSpark ? 1.0 : 0.0;
            angles[i] = p.angle;
        }

        // Upload to dynamic buffers
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFirePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireSizeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, sizes, gl.DYNAMIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireLifeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lives, gl.DYNAMIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireSparkBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, sparks, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireAngleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, angles, gl.DYNAMIC_DRAW);

        // Bind attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFirePositionBuffer);
        const posLoc = gl.getAttribLocation(window._webglFireProgram, 'a_position');
        if (posLoc !== -1) {
            gl.enableVertexAttribArray(posLoc);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        }
        
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireSizeBuffer);
        const sizeLoc = gl.getAttribLocation(window._webglFireProgram, 'a_size');
        if (sizeLoc !== -1) {
            gl.enableVertexAttribArray(sizeLoc);
            gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, 0, 0);
        }
        
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireLifeBuffer);
        const lifeLoc = gl.getAttribLocation(window._webglFireProgram, 'a_life');
        if (lifeLoc !== -1) {
            gl.enableVertexAttribArray(lifeLoc);
            gl.vertexAttribPointer(lifeLoc, 1, gl.FLOAT, false, 0, 0);
        }
        
        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireSparkBuffer);
        const sparkLoc = gl.getAttribLocation(window._webglFireProgram, 'a_isSpark');
        if (sparkLoc !== -1) {
            gl.enableVertexAttribArray(sparkLoc);
            gl.vertexAttribPointer(sparkLoc, 1, gl.FLOAT, false, 0, 0);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, window._webglFireAngleBuffer);
        const angleLoc = gl.getAttribLocation(window._webglFireProgram, 'a_angle');
        if (angleLoc !== -1) {
            gl.enableVertexAttribArray(angleLoc);
            gl.vertexAttribPointer(angleLoc, 1, gl.FLOAT, false, 0, 0);
        }

        // Bind Texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, window._webglFireTexture);
        const uTex = gl.getUniformLocation(window._webglFireProgram, 'u_texture');
        gl.uniform1i(uTex, 0);

        // Bind Uniforms
        const uRes = gl.getUniformLocation(window._webglFireProgram, 'u_resolution');
        gl.uniform2f(uRes, canvasWidth, canvasHeight);

        const uThick = gl.getUniformLocation(window._webglFireProgram, 'u_borderThickness');
        gl.uniform1f(uThick, this.borderThickness);

        const uAlpha = gl.getUniformLocation(window._webglFireProgram, 'u_alpha');
        gl.uniform1f(uAlpha, this.colorA);

        const uOutline = gl.getUniformLocation(window._webglFireProgram, 'u_enableOutline');
        gl.uniform1f(uOutline, this.enableOutline ? 1.0 : 0.0);

        const uCol = gl.getUniformLocation(window._webglFireProgram, 'u_color');
        gl.uniform3f(uCol, this.colorRgb[0], this.colorRgb[1], this.colorRgb[2]);

        const uCol2 = gl.getUniformLocation(window._webglFireProgram, 'u_color2');
        gl.uniform3f(uCol2, this.color2Rgb[0], this.color2Rgb[1], this.color2Rgb[2]);

        const uColOutline = gl.getUniformLocation(window._webglFireProgram, 'u_colorOutline');
        gl.uniform3f(uColOutline, this.colorOutlineRgb[0], this.colorOutlineRgb[1], this.colorOutlineRgb[2]);

        // Enable Blending
        gl.enable(gl.BLEND);
        if (this.enableOutline) {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } else {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive blending for realistic fire glow!
        }

        // Draw points
        gl.drawArrays(gl.POINTS, 0, this.particles.length);

        if (posLoc !== -1) gl.disableVertexAttribArray(posLoc);
        if (sizeLoc !== -1) gl.disableVertexAttribArray(sizeLoc);
        if (lifeLoc !== -1) gl.disableVertexAttribArray(lifeLoc);
        if (sparkLoc !== -1) gl.disableVertexAttribArray(sparkLoc);
        if (angleLoc !== -1) gl.disableVertexAttribArray(angleLoc);
    }
}
