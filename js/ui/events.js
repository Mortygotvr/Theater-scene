// Global DOM Events and Initialization
window.preferencesManager = new PreferencesManager();

// Support for WebSocket Event Log
window.logTheatreEvent = function(msg, isError = false) {
    const win = document.getElementById('ws-log-window');
    if (!win) return;
    const d = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    div.style.borderBottom = '1px solid #222';
    div.style.paddingBottom = '4px';
    const colorCode = isError ? '#ff5252' : (msg.includes('Match Found') ? '#00ffcc' : '#fff');
    div.innerHTML = `<span style="color: #666;">[${d}]</span> <span style="color: ${colorCode}">${msg}</span>`;
    win.appendChild(div);
    if (win.children.length > 100) {
        win.removeChild(win.firstChild);
    }
    win.scrollTop = win.scrollHeight;
};

// Autoplay policy unlock helper. Listen to first interaction to unlock audio.
document.addEventListener('DOMContentLoaded', () => {
    const unlockAudio = () => {
        const audioCtx = window.AudioContext ? new AudioContext() : (window.webkitAudioContext ? new webkitAudioContext() : null);
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA');
        silentAudio.play().then(() => {
            console.log("[Audio Unlock] Audio system successfully unlocked via user interaction.");
            removeUnlockListeners();
        }).catch(e => {
            console.warn("[Audio Unlock] Autoplay unlock failed, will retry on next interaction:", e);
        });
    };

    const removeUnlockListeners = () => {
        document.removeEventListener('click', unlockAudio);
        document.removeEventListener('keydown', unlockAudio);
        document.removeEventListener('mousedown', unlockAudio);
        document.removeEventListener('pointerdown', unlockAudio);
    };

    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    document.addEventListener('mousedown', unlockAudio);
    document.addEventListener('pointerdown', unlockAudio);
});

// Setup window.initUIElements to dispatch config-updated event to Alpine
window.initUIElements = () => {
    if (window.configManager) {
        const liveConfig = window.configManager.loadConfig();
        window.dispatchEvent(new CustomEvent('config-updated', { detail: liveConfig }));
    }
};

// Alpine.js Application State & Component declaration
document.addEventListener('alpine:init', () => {
    Alpine.data('settingsApp', () => ({
        isOpen: false,
        activeTab: 'object',

        // Preferences model
        prefMaxEntities: 100,
        prefItemDuration: 3000,
        prefStickyTracking: true,
        prefSmoothingEnabled: true,

        // Configuration state matching IN_MEMORY_CONFIG
        config: {
            discordIP: 'localhost',
            objects: [],
            targets: [],
            triggers: [],
            camera_tracking: {
                avatar_source: '',
                active_scene: '',
                mode: 'chroma',
                threshold: 40,
                chroma_color: '#00ff00',
                chroma_r: 0,
                chroma_g: 255,
                chroma_b: 0,
                secondary_sources: []
            },
            avatarSync: {
                enabled: false,
                scene: '',
                source: '',
                scaleMult: 1.0,
                smoothing: 0.15
            },
            parallax: {
                enabled: false,
                useSmoothing: false,
                smoothingFactor: 0.15,
                intensity: 1.0,
                zSpeed: 0.1,
                driverSource: 'camera',
                anchorLayer: 3,
                targetScene: '',
                layers: [
                    { name: '', baseScale: 1.0 },
                    { name: '', baseScale: 1.0 },
                    { name: '', baseScale: 1.0 },
                    { name: '', baseScale: 1.0 },
                    { name: '', baseScale: 1.0 }
                ]
            },
            hasFloor: true,
            obsEnable: false,
            obsIP: '127.0.0.1',
            obsPort: '4455',
            obsPassword: '',
            obs_bridge: {
                enabled: false,
                ip: '127.0.0.1',
                port: '4455',
                password: '',
                obs_url: '',
                obs_pass: ''
            }
        },

        init() {
            // Load initial preferences
            this.prefMaxEntities = window.preferencesManager?.maxEntities || 100;
            this.prefItemDuration = window.preferencesManager?.itemDuration || 3000;
            this.prefStickyTracking = window.preferencesManager?.stickyTracking !== false;
            this.prefSmoothingEnabled = window.preferencesManager?.smoothingEnabled !== false;

            // Load initial config from configManager
            if (window.configManager) {
                // Restore objects from localStorage before merging, in case server had none
                window.configManager.restoreObjectsFromLocal();
                const withRestoredObjects = window.configManager.loadConfig();
                if (withRestoredObjects) {
                    this.mergeConfig(withRestoredObjects);
                    // Connect to OBS if enabled
                    if (window.obsBridge && withRestoredObjects.obs_bridge && withRestoredObjects.obs_bridge.enabled) {
                        window.obsBridge.connect(withRestoredObjects.obs_bridge.ip, withRestoredObjects.obs_bridge.port, withRestoredObjects.obs_bridge.password);
                    }
                }
            }

            // Watch preferences inputs
            this.$watch('prefMaxEntities', val => {
                if (window.preferencesManager) {
                    window.preferencesManager.maxEntities = val;
                    window.preferencesManager.saveSettings();
                }
            });
            this.$watch('prefItemDuration', val => {
                if (window.preferencesManager) {
                    window.preferencesManager.itemDuration = val;
                    window.preferencesManager.saveSettings();
                }
            });
            this.$watch('prefStickyTracking', val => {
                if (window.preferencesManager) {
                    window.preferencesManager.stickyTracking = val;
                    window.preferencesManager.saveSettings();
                }
            });
            this.$watch('prefSmoothingEnabled', val => {
                if (window.preferencesManager) {
                    window.preferencesManager.smoothingEnabled = val;
                    window.preferencesManager.saveSettings();
                }
            });

            // Listen for configuration updates from websocket
            window.addEventListener('config-updated', (e) => {
                // If the user is actively typing or editing an input, do not merge incoming config
                // to prevent Alpine reactivity from refreshing DOM elements and stealing focus/resetting cursor.
                const active = document.activeElement;
                const isEditing = active && (
                    active.tagName === 'INPUT' || 
                    active.tagName === 'TEXTAREA' || 
                    active.tagName === 'SELECT'
                );
                if (isEditing) {
                    console.log("[Theatre] Skipping config merge: user is actively editing a form field.");
                    return;
                }
                this.mergeConfig(e.detail);
                
                // Repopulate OBS dropdowns with correct loaded values to prevent desync
                setTimeout(() => {
                    document.querySelectorAll('select.obs-input').forEach(el => {
                        const type = el.dataset.obsType;
                        const parent = el.dataset.obsParent;
                        let val = "";
                        if (el.id === 'avatar_target_scene') {
                            val = this.config.camera_tracking.avatar_source;
                        } else if (el.id === 'active_obs_scene') {
                            val = this.config.camera_tracking.active_scene;
                        } else if (el.classList.contains('target-obs-source')) {
                            try {
                                const targetScope = Alpine.evaluate(el, 'target');
                                if (targetScope) val = targetScope.obsSource;
                            } catch(err) {}
                        } else if (el.classList.contains('action-scene')) {
                            try {
                                const actionScope = Alpine.evaluate(el, 'action');
                                if (actionScope) val = actionScope.scene;
                            } catch(err) {}
                        } else if (el.classList.contains('action-source')) {
                            try {
                                const actionScope = Alpine.evaluate(el, 'action');
                                if (actionScope) val = actionScope.source;
                            } catch(err) {}
                        } else if (el.classList.contains('action-filter')) {
                            try {
                                const actionScope = Alpine.evaluate(el, 'action');
                                if (actionScope) val = actionScope.filter;
                            } catch(err) {}
                        }
                        if (type) {
                            window.ObsDropbox.populate(el, type, parent, val);
                        }
                    });
                }, 100);
            });
        },

        mergeConfig(newConfig) {
            this.config = JSON.parse(JSON.stringify(Object.assign({}, this.config, newConfig)));
            
            // Sanitize triggers to ensure default values exist
            if (this.config.triggers) {
                this.config.triggers.forEach(trig => {
                    if (trig.target === undefined || trig.target === '') {
                        trig.target = 'avatar';
                    }
                    if (trig.objectId === undefined) {
                        trig.objectId = '';
                    }
                    const actionLists = ['obsActions', 'collisionActions', 'lastCollisionActions'];
                    actionLists.forEach(list => {
                        if (trig[list]) {
                            trig[list].forEach(action => {

                                if (action.type === 'throw_object') {
                                    if (action.target === undefined || action.target === '') {
                                        action.target = 'avatar';
                                    }
                                    if (action.objectId === undefined) {
                                        action.objectId = '';
                                    }
                                }
                                if (action.type === 'set_crop') {
                                    if (action.value === undefined || action.value === '') {
                                        action.value = 'avatar';
                                    }
                                }
                            });
                        }
                    });
                });
            }

            // Initialize scale properties for object scaling
            if (this.config.objects) {
                this.config.objects.forEach(obj => {
                    if (obj.type === 'image') {
                        if (!obj.scale) obj.scale = 1.0;
                        if (!obj.originalWidth) {
                            obj.originalWidth = Math.round((obj.width || 100) / (parseFloat(obj.scale) || 1.0));
                        }
                        if (!obj.originalHeight) {
                            obj.originalHeight = Math.round((obj.height || 100) / (parseFloat(obj.scale) || 1.0));
                        }
                    }
                    if (obj.type === 'webgl-water') {
                        if (obj.colorR === undefined) {
                            let hex = obj.color || '#00aaff';
                            if (hex.startsWith('#')) hex = hex.slice(1);
                            if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
                            const r = parseInt(hex.slice(0, 2), 16);
                            const g = parseInt(hex.slice(2, 4), 16);
                            const b = parseInt(hex.slice(4, 6), 16);
                            obj.colorR = isNaN(r) ? 0 : r;
                            obj.colorG = isNaN(g) ? 170 : g;
                            obj.colorB = isNaN(b) ? 255 : b;
                            obj.colorA = obj.colorA !== undefined ? obj.colorA : 0.95;
                        }
                        if (obj.dripShrink === undefined) {
                            obj.dripShrink = 16;
                        }
                        if (obj.dripThroughPercent === undefined) {
                            obj.dripThroughPercent = 50;
                        }
                        if (obj.enableOutline === undefined) {
                            obj.enableOutline = true;
                        }
                        if (obj.color2R === undefined) {
                            obj.color2R = 100;
                            obj.color2G = 210;
                            obj.color2B = 255;
                        }
                        if (obj.color2A === undefined) {
                            obj.color2A = 0.85;
                        }
                    }
                    if (obj.type === 'webgl-fire') {
                        if (obj.colorR === undefined) {
                            obj.colorR = 255;
                            obj.colorG = 80;
                            obj.colorB = 0;
                            obj.colorA = 0.95;
                        }
                        if (obj.color2R === undefined) {
                            obj.color2R = 255;
                            obj.color2G = 220;
                            obj.color2B = 0;
                            obj.color2A = 0.85;
                        }
                        if (obj.fluidCount === undefined) obj.fluidCount = 400;
                        if (obj.fluidRadius === undefined) obj.fluidRadius = 16;
                        if (obj.fluidViscosity === undefined) obj.fluidViscosity = 0.6;
                        if (obj.fluidDuration === undefined) obj.fluidDuration = 3000;
                        if (obj.fluidGravity === undefined) obj.fluidGravity = -0.4;
                        if (obj.fluidWidth === undefined) obj.fluidWidth = 35;
                        if (obj.dripShrink === undefined) obj.dripShrink = 25;
                        if (obj.dripThroughPercent === undefined) obj.dripThroughPercent = 0;
                        if (obj.enableOutline === undefined) obj.enableOutline = true;
                    }
                    if (obj.type === 'webgl-lightning') {
                        if (obj.colorR === undefined) {
                            obj.colorR = 180;
                            obj.colorG = 220;
                            obj.colorB = 255;
                            obj.colorA = 1.0;
                        }
                        if (obj.strikeCount === undefined) obj.strikeCount = 3;
                        if (obj.boltCount === undefined) obj.boltCount = 2;
                        if (obj.branching === undefined) obj.branching = 3;
                        if (obj.boltWidth === undefined) obj.boltWidth = 4.0;
                        if (obj.duration === undefined) obj.duration = 500;
                        if (obj.roughness === undefined) obj.roughness = 0.5;
                        if (obj.straightness === undefined) obj.straightness = 0.8;
                        if (obj.speed === undefined) obj.speed = 1.0;
                        if (obj.enableBloom === undefined) obj.enableBloom = true;
                        if (obj.stopAtMask === undefined) obj.stopAtMask = false;
                        if (obj.maxIterations === undefined) obj.maxIterations = 12;
                        if (obj.bloomColorR === undefined) obj.bloomColorR = obj.colorR !== undefined ? obj.colorR : 180;
                        if (obj.bloomColorG === undefined) obj.bloomColorG = obj.colorG !== undefined ? obj.colorG : 220;
                        if (obj.bloomColorB === undefined) obj.bloomColorB = obj.colorB !== undefined ? obj.colorB : 255;
                        if (obj.bloomColorA === undefined) obj.bloomColorA = obj.colorA !== undefined ? obj.colorA : 1.0;
                        if (obj.bloomSize === undefined) obj.bloomSize = 1.0;
                    }
                });
            }
        },

        // Throwable/Audio functions
        addObject(type) {
            const id = 'obj_' + Date.now();
            let newObj;
            if (type === 'snapshot') {
                newObj = {
                    id,
                    name: 'Camera Snapshot',
                    type: 'snapshot',
                    obsSource: '',
                    cutoutMode: 'brightness',
                    brightnessThreshold: 40,
                    targetHeight: 200,
                    action: 'throwable',
                    target: 'avatar',
                    collision: 'bounce',
                    spawnPoints: ['ml', 'mr'],
                    snapBottom: false,
                    randomMirror: true
                };
            } else if (type === 'webgl-water') {
                newObj = {
                    id,
                    name: 'WebGL Water',
                    type: 'webgl-water',
                    colorR: 0,
                    colorG: 170,
                    colorB: 255,
                    colorA: 0.95,
                    color2R: 100,
                    color2G: 210,
                    color2B: 255,
                    color2A: 0.85,
                    borderThickness: 0.06,
                    fluidCount: 150,
                    fluidRadius: 15,
                    fluidViscosity: 0.5,
                    fluidDuration: 6000,
                    fluidGravity: 0.8,
                    fluidWidth: 30,
                    dripShrink: 16,
                    dripThroughPercent: 50,
                    enableOutline: true,
                    action: 'throwable',
                    target: 'avatar',
                    streamMode: 'top',
                    spawnPoints: ['tc'],
                    snapBottom: false,
                    randomMirror: false
                };
            } else if (type === 'webgl-fire') {
                newObj = {
                    id,
                    name: 'WebGL Fire',
                    type: 'webgl-fire',
                    colorR: 255,
                    colorG: 80,
                    colorB: 0,
                    colorA: 0.95,
                    color2R: 255,
                    color2G: 220,
                    color2B: 0,
                    color2A: 0.85,
                    borderThickness: 0.08,
                    fluidCount: 400,
                    fluidRadius: 16,
                    fluidViscosity: 0.6,
                    fluidDuration: 3000,
                    fluidGravity: -0.4,
                    fluidWidth: 35,
                    dripShrink: 25,
                    dripThroughPercent: 0,
                    enableOutline: true,
                    action: 'throwable',
                    target: 'avatar',
                    streamMode: 'grid',
                    spawnPoints: ['bc'],
                    snapBottom: false,
                    randomMirror: false
                };
            } else if (type === 'webgl-lightning') {
                newObj = {
                    id,
                    name: 'WebGL Lightning',
                    type: 'webgl-lightning',
                    colorR: 180,
                    colorG: 220,
                    colorB: 255,
                    colorA: 1.0,
                    bloomColorR: 180,
                    bloomColorG: 220,
                    bloomColorB: 255,
                    bloomColorA: 1.0,
                    bloomSize: 1.0,
                    maxIterations: 12,
                    strikeCount: 3,
                    boltCount: 2,
                    branching: 3,
                    boltWidth: 4.0,
                    duration: 500,
                    roughness: 0.5,
                    straightness: 0.8,
                    speed: 1.0,
                    enableBloom: true,
                    stopAtMask: false,
                    action: 'throwable',
                    target: 'avatar',
                    spawnPoints: ['tc'],
                    snapBottom: false,
                    randomMirror: false
                };
            } else {
                newObj = {
                    id,
                    name: type === 'audio' ? 'New Audio' : 'New Throwable',
                    type: type,
                    target: 'avatar',
                    action: type === 'audio' ? null : 'throwable',
                    collision: type === 'audio' ? null : 'bounce',
                    spawnPoints: ['mc'],
                    snapBottom: false,
                    randomMirror: type === 'audio' ? false : true,
                    imageSrc: null,
                    startSound: null,
                    collisionSound: null,
                    width: 100,
                    height: 100,
                    scale: 1.0,
                    originalWidth: 100,
                    originalHeight: 100
                };
            }
            this.config.objects.push(newObj);
            this.saveConfigRaw();
        },

        deleteObject(id) {
            this.config.objects = this.config.objects.filter(o => o.id !== id);
            // Clean references in triggers
            this.config.triggers.forEach(trig => {
                if (trig.objectId === id) {
                    trig.objectId = '';
                }
            });
            this.saveConfigRaw();
        },

        uploadImageFile(event, obj) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const rawSrc = e.target.result;
                if (file.type.includes('gif')) {
                    const img = new Image();
                    img.onload = () => {
                        obj.imageSrc = rawSrc;
                        obj.originalWidth = img.width;
                        obj.originalHeight = img.height;
                        obj.scale = 1.0;
                        obj.width = img.width;
                        obj.height = img.height;
                        this.saveConfigRaw();
                    };
                    img.src = rawSrc;
                    return;
                }
                const img = new Image();
                img.onload = () => {
                    const MAX_DIM = 500;
                    let w = img.width;
                    let h = img.height;
                    if (w > MAX_DIM || h > MAX_DIM) {
                        if (w > h) {
                            h = Math.floor(h * (MAX_DIM / w));
                            w = MAX_DIM;
                        } else {
                            w = Math.floor(w * (MAX_DIM / h));
                            h = MAX_DIM;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    obj.imageSrc = canvas.toDataURL('image/webp', 0.85);
                    obj.originalWidth = w;
                    obj.originalHeight = h;
                    obj.scale = 1.0;
                    obj.width = w;
                    obj.height = h;
                    this.saveConfigRaw();
                };
                img.src = rawSrc;
            };
            reader.readAsDataURL(file);
        },

        uploadAudioFile(event, obj, field = 'startSound') {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                obj[field] = e.target.result;
                this.saveConfigRaw();
            };
            reader.readAsDataURL(file);
        },

        testObject(obj) {
            console.log("[DEBUG] Testing object:", obj);
            try {
                if (typeof window.spawnItem !== 'function') {
                    if (window.theatreWs && window.theatreWs.ws && window.theatreWs.ws.readyState === WebSocket.OPEN) {
                        window.theatreWs.ws.send(JSON.stringify({
                            type: "test_object",
                            payload: obj
                        }));
                        return;
                    } else {
                        throw new Error("WebSocket connection to overlay is offline.");
                    }
                }

                if (obj.type === 'snapshot') {
                    // Live capture path — no pre-loaded image needed
                    if (typeof window.spawnItem === 'function') {
                        window.spawnItem({ ...obj });
                    }
                    return;
                }
                if (!obj.imageSrc && obj.type === 'image') throw new Error("Please upload an image first!");
                if (!obj.startSound && obj.type === 'audio') throw new Error("Please upload an audio file first!");
                
                if (typeof window.spawnItem === 'function') {
                    window.spawnItem(obj);
                } else {
                    console.error("spawnItem function is not available.");
                }
            } catch (err) {
                console.error("Test spawn failed:", err);
                alert(err.message);
            }
        },

        // Target functions
        addTarget() {
            const id = 'target_' + Date.now();
            const newTarg = {
                id: id,
                name: 'New Target',
                obsScene: this.config.camera_tracking.active_scene || '',
                obsSource: '',
                marginLeft: 0,
                marginRight: 0,
                marginTop: 0,
                marginBottom: 0
            };
            this.config.targets.push(newTarg);
            this.saveConfigRaw();
            if (window.theatreSystem) window.theatreSystem.refreshTargets();
        },

        deleteTarget(id) {
            this.config.targets = this.config.targets.filter(t => t.id !== id);
            this.saveConfigRaw();
            if (window.theatreSystem) window.theatreSystem.refreshTargets();
        },

        // Trigger functions
        addTrigger() {
            const id = 'trig_' + Date.now();
            const newTrig = {
                id: id,
                events: 'Twitch * sub',
                objectId: '',
                target: 'avatar',
                amount: '1',
                speed: '',
                delay: 0,
                repeatDelay: 200,
                obsActions: [],
                collisionActions: [],
                lastCollisionActions: []
            };
            this.config.triggers.push(newTrig);
            this.saveConfigRaw();
        },

        deleteTrigger(id) {
            this.config.triggers = this.config.triggers.filter(t => t.id !== id);
            this.saveConfigRaw();
        },

        addObsAction(trigger, listName) {
            const newAction = {
                type: 'toggle_source',
                scene: '',
                source: '',
                filter: '',
                settingKey: '',
                delay: 0,
                duration: 1000,
                value: '',
                target: 'avatar',
                amount: '1',
                speed: '',
                repeatDelay: 200,
                collisionSound: '',
                objectId: ''
            };
            if (!trigger[listName]) trigger[listName] = [];
            trigger[listName].push(newAction);
            this.saveConfigRaw();
        },

        deleteObsAction(trigger, listName, index) {
            if (trigger[listName]) {
                trigger[listName].splice(index, 1);
            }
            this.saveConfigRaw();
        },

        testTrigger(trigger) {
            console.log("[DEBUG] Testing trigger:", trigger);
            try {
                // Always execute locally — this handles OBS actions even when the overlay is not open.
                // executeTriggerObj gracefully skips spawnCallback if it's not available (config.html).
                if (window.theatreWs && typeof window.theatreWs.executeTriggerObj === 'function') {
                    window.theatreWs.executeTriggerObj(trigger, { username: "TestUser", tier: 1 });
                } else {
                    console.warn("[Theatre] executeTriggerObj not found on this page.");
                }

                // Additionally broadcast via WebSocket so the overlay (index.html) can perform
                // the visual spawn if it's currently open as a connected client.
                if (typeof window.spawnItem !== 'function' &&
                    window.theatreWs && window.theatreWs.ws &&
                    window.theatreWs.ws.readyState === WebSocket.OPEN) {
                    window.theatreWs.ws.send(JSON.stringify({
                        type: "test_trigger",
                        payload: trigger
                    }));
                }
            } catch (e) {
                console.error("Trigger test failed:", e);
                alert(e.message);
            }
        },

        // Save logic
        saveConfigRaw() {
            // Check if this was triggered by a programmatic/non-trusted event
            const ev = window.event;
            if (ev && ev.isTrusted === false) {
                console.log("[Theatre] Ignoring saveConfigRaw: programmatic event.", ev.type);
                return;
            }
            if (window.programmaticPopulateCounter && window.programmaticPopulateCounter > 0) {
                console.log("[Theatre] Ignoring saveConfigRaw: currently populating dropdowns programmatically.");
                return;
            }
            if (window.configManager) {
                // Sync secondary sources with targets
                if (this.config.camera_tracking && this.config.targets) {
                    this.config.camera_tracking.secondary_sources = this.config.targets
                        .map(t => t.obsSource)
                        .filter(s => s);
                }
                // Update configManager memory
                window.configManager.IN_MEMORY_CONFIG = JSON.parse(JSON.stringify(this.config));
                window.configManager.saveConfigDB_Raw(this.config);
            }
        },

        async saveAll() {
            const btn = document.getElementById('save-all-btn');
            const oldText = btn.innerText;
            btn.innerText = 'Saving...';
            btn.disabled = true;

            try {
                // Validate fields before save
                this.config.objects.forEach(obj => {
                    if (obj.type === 'image' && !obj.imageSrc) {
                        throw new Error(`Throwable "${obj.name}" requires an Image/GIF asset.`);
                    }
                    if (obj.type === 'audio' && !obj.startSound) {
                        throw new Error(`Audio "${obj.name}" requires an Audio file.`);
                    }
                });

                this.config.targets.forEach(t => {
                    if (!t.name.trim()) {
                        throw new Error(`Target requires a name.`);
                    }
                });

                this.config.triggers.forEach(trig => {
                    if (!trig.events.trim()) {
                        throw new Error(`Trigger requires a pattern.`);
                    }
                });

                // Sync secondary sources with targets
                if (this.config.camera_tracking && this.config.targets) {
                    this.config.camera_tracking.secondary_sources = this.config.targets
                        .map(t => t.obsSource)
                        .filter(s => s);
                }

                if (window.configManager) {
                    window.configManager.IN_MEMORY_CONFIG = JSON.parse(JSON.stringify(this.config));
                    await window.configManager.saveConfigDB_Raw(this.config);
                }

                btn.innerText = 'Saved!';
                setTimeout(() => {
                    btn.innerText = oldText;
                    btn.disabled = false;
                }, 2000);
            } catch (err) {
                console.error("Save All Error:", err);
                btn.innerText = 'Error!';
                alert("Save failed: " + err.message);
                setTimeout(() => {
                    btn.innerText = oldText;
                    btn.disabled = false;
                }, 2000);
            }
        },

        exportConfig() {
            try {
                const exportData = {
                    preferences: {
                        maxEntities: this.prefMaxEntities,
                        itemDuration: this.prefItemDuration,
                        stickyTracking: this.prefStickyTracking,
                        smoothingEnabled: this.prefSmoothingEnabled
                    },
                    config: this.config
                };
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 4));
                const downloadAnchor = document.createElement('a');
                downloadAnchor.setAttribute("href", dataStr);
                downloadAnchor.setAttribute("download", "theatre_settings.json");
                document.body.appendChild(downloadAnchor);
                downloadAnchor.click();
                downloadAnchor.remove();
            } catch (err) {
                console.error("Export settings failed:", err);
                alert("Failed to export settings: " + err.message);
            }
        },

        importConfig(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const imported = JSON.parse(e.target.result);
                    if (!imported || typeof imported !== 'object') {
                        throw new Error("Invalid settings file format.");
                    }
                    
                    let configData = null;
                    let prefData = null;
                    
                    if (imported.config && typeof imported.config === 'object') {
                        configData = imported.config;
                        prefData = imported.preferences;
                    } else {
                        configData = imported;
                    }
                    
                    const hasObjects = Array.isArray(configData.objects);
                    const hasTriggers = Array.isArray(configData.triggers);
                    if (!hasObjects && !hasTriggers && !configData.obs_bridge && !configData.camera_tracking) {
                        throw new Error("Invalid or unrecognized configuration settings.");
                    }

                    if (!confirm("Are you sure you want to load these settings? This will overwrite your current configuration.")) {
                        event.target.value = '';
                        return;
                    }

                    if (prefData && typeof prefData === 'object') {
                        if (prefData.maxEntities !== undefined) this.prefMaxEntities = prefData.maxEntities;
                        if (prefData.itemDuration !== undefined) this.prefItemDuration = prefData.itemDuration;
                        if (prefData.stickyTracking !== undefined) this.prefStickyTracking = prefData.stickyTracking;
                        if (prefData.smoothingEnabled !== undefined) this.prefSmoothingEnabled = prefData.smoothingEnabled;
                        
                        if (window.preferencesManager) {
                            window.preferencesManager.maxEntities = this.prefMaxEntities;
                            window.preferencesManager.itemDuration = this.prefItemDuration;
                            window.preferencesManager.stickyTracking = this.prefStickyTracking;
                            window.preferencesManager.smoothingEnabled = this.prefSmoothingEnabled;
                            window.preferencesManager.saveSettings();
                        }
                    }

                    this.mergeConfig(configData);
                    
                    if (window.configManager) {
                        window.configManager.IN_MEMORY_CONFIG = JSON.parse(JSON.stringify(this.config));
                        await window.configManager.saveConfigDB_Raw(this.config);
                    }

                    alert("Settings loaded successfully! Refreshing tracking/targets...");
                    
                    if (window.theatreSystem) window.theatreSystem.refreshTargets();
                    
                    if (window.obsBridge && this.config.obs_bridge && this.config.obs_bridge.enabled) {
                        window.obsBridge.connect(this.config.obs_bridge.ip, this.config.obs_bridge.port, this.config.obs_bridge.password);
                    }
                    
                } catch (err) {
                    console.error("Import settings failed:", err);
                    alert("Failed to load settings: " + err.message);
                } finally {
                    event.target.value = '';
                }
            };
            reader.readAsText(file);
        },

        // Helper to fetch filter properties for action rows
        async fetchFilterProperties(sourceName, filterName) {
            if (sourceName && filterName && window.obsBridge && window.obsBridge.connected) {
                try {
                    const resp = await window.obsBridge.sendRequest("GetSourceFilter", { 
                        sourceName: sourceName, 
                        filterName: filterName 
                    });
                    if (resp?.requestStatus?.result && resp.responseData?.filterSettings) {
                        return Object.keys(resp.responseData.filterSettings);
                    }
                } catch (e) {
                    console.warn("Failed to fetch filter settings:", e);
                }
            }
            return [];
        },

        // Helper to convert hex to rgb for color input binding
        hexToRgb(hex) {
            var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : { r: 0, g: 255, b: 0 };
        },

        rgbToHex(r, g, b) {
            const clamp = (val) => Math.max(0, Math.min(255, Math.round(val)));
            const componentToHex = (c) => {
                const hex = clamp(c).toString(16);
                return hex.length === 1 ? "0" + hex : hex;
            };
            return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
        }
    }));
});
