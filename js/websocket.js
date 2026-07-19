window.replaceTriggerVariables = function(text, matches, payload) {
    if (!text && text !== 0) return "";
    let finalTxt = String(text);
    
    // Replace {1}, {2}, etc. with wildcards
    if (matches && matches.length > 0) {
        matches.forEach((m, idx) => {
            finalTxt = finalTxt.replace(new RegExp(`\\{${idx + 1}\\}`, 'g'), m);
        });
    }
    
    // Replace {key} with values from the JSON payload
    if (payload) {
        for (const key in payload) {
            if (payload.hasOwnProperty(key) && typeof payload[key] !== 'object') {
                finalTxt = finalTxt.replace(new RegExp(`\\{${key}\\}`, 'g'), payload[key]);
            }
        }

        // Support for nested properties like {customData.tier}
        if (payload.customData) {
            for (const nestedKey in payload.customData) {
                if (payload.customData.hasOwnProperty(nestedKey)) {
                    finalTxt = finalTxt.replace(new RegExp(`\\{customData\\.${nestedKey}\\}`, 'g'), payload.customData[nestedKey]);
                    // Fallback shortcut, e.g., {tier}
                    finalTxt = finalTxt.replace(new RegExp(`\\{${nestedKey}\\}`, 'g'), payload.customData[nestedKey]);
                }
            }
        }
    }
    return finalTxt;
};

class TriggerSystem {
    constructor(spawnCallback) {
        this.spawnCallback = spawnCallback;
        this.hasLoadedInitialConfig = false;
        
        const self = this;
        // Capture uncaught script errors
        window.addEventListener('error', function (e) {
            if (self.ws && typeof self.ws.send === 'function') {
                try {
                    self.ws.send(JSON.stringify({
                        type: 'client_error',
                        message: e.message,
                        filename: e.filename,
                        lineno: e.lineno,
                        colno: e.colno,
                        stack: e.error ? e.error.stack : ''
                    }));
                } catch (err) {}
            }
        });

        // Capture console.error calls
        const originalConsoleError = console.error;
        console.error = function() {
            originalConsoleError.apply(console, arguments);
            const msg = Array.from(arguments).map(arg => {
                try { return typeof arg === 'object' ? JSON.stringify(arg) : String(arg); }
                catch(e) { return String(arg); }
            }).join(' ');
            if (self.ws && typeof self.ws.send === 'function') {
                try {
                    self.ws.send(JSON.stringify({
                        type: 'client_error',
                        message: msg,
                        filename: 'console',
                        lineno: 0,
                        colno: 0,
                        stack: new Error().stack || ''
                    }));
                } catch(err) {}
            }
        };

        // Capture console.log calls for visual tracing
        const originalConsoleLog = console.log;
        console.log = function() {
            originalConsoleLog.apply(console, arguments);
            const msg = Array.from(arguments).map(arg => {
                try { return typeof arg === 'object' ? JSON.stringify(arg) : String(arg); }
                catch(e) { return String(arg); }
            }).join(' ');
            if (self.ws && typeof self.ws.send === 'function') {
                try {
                    self.ws.send(JSON.stringify({
                        type: 'client_log',
                        message: msg
                    }));
                } catch(err) {}
            }
        };

        this.connect();
    }

    connect() {
        const urlParams = new URLSearchParams(window.location.search);
        const defaultReaderPort = (window.LAUNCH_PORTS && window.LAUNCH_PORTS.readerPort) || '41837';
        const defaultScenePort = (window.LAUNCH_PORTS && window.LAUNCH_PORTS.scenePort) || '41839';
        const readerPort = urlParams.get('readerPort') || urlParams.get('port') || defaultReaderPort;
        const scenePort = urlParams.get('scenePort') || defaultScenePort;

        // Store params so forceReconnect() can use them without re-parsing
        this._readerPort = readerPort;
        this._scenePort = scenePort;

        console.log(`[Theatre] Connecting: Reader port ${readerPort}, Scene port ${scenePort}`);

        const backendStatus = document.getElementById('backend-status-msg');
        if (backendStatus) {
            backendStatus.innerText = "Backend: Connecting...";
            backendStatus.style.color = "#ffaa00";
        }

        this.readerWsConnected = false;
        this.sceneWsConnected = false;

        const updateStatusUI = () => {
            if (backendStatus) {
                if (this.readerWsConnected && this.sceneWsConnected) {
                    backendStatus.innerText = "Backend: Connected (Dual)";
                    backendStatus.style.color = "#00ffcc";
                } else if (this.readerWsConnected) {
                    backendStatus.innerText = "Backend: Reader Only";
                    backendStatus.style.color = "#88ffcc";
                } else if (this.sceneWsConnected) {
                    backendStatus.innerText = "Backend: Scene Only";
                    backendStatus.style.color = "#ccff88";
                } else {
                    backendStatus.innerText = "Backend: Offline";
                    backendStatus.style.color = "#ff4444";
                }
            }
        };

        // Store so forceReconnect() can rebuild the status UI correctly
        this._updateStatusUI = updateStatusUI;

        this.connectReader(readerPort, updateStatusUI);
        this.connectScene(scenePort, updateStatusUI);

        const self = this;

        // Mock this.ws interface
        this.ws = {
            send: (payload) => {
                let parsed = null;
                try {
                    parsed = JSON.parse(payload);
                } catch(e) {}
                const isModifying = parsed && (parsed.type === "save_config" || parsed.type === "update_obs_config" || parsed.type === "save_theater_config");

                if (!isModifying && self.readerWs && self.readerWs.readyState === WebSocket.OPEN) {
                    self.readerWs.send(payload);
                }
                if (self.sceneWs && self.sceneWs.readyState === WebSocket.OPEN) {
                    self.sceneWs.send(payload);
                }
            },
            get readyState() {
                const rOpen = self.readerWs && self.readerWs.readyState === WebSocket.OPEN;
                const sOpen = self.sceneWs && self.sceneWs.readyState === WebSocket.OPEN;
                if (rOpen || sOpen) return WebSocket.OPEN;
                
                const rConn = self.readerWs && self.readerWs.readyState === WebSocket.CONNECTING;
                const sConn = self.sceneWs && self.sceneWs.readyState === WebSocket.CONNECTING;
                if (rConn || sConn) return WebSocket.CONNECTING;
                
                return WebSocket.CLOSED;
            }
        };
    }

    // Immediately tear down existing connections and reconnect from scratch.
    // Used by the debug Reset State button to simulate a fresh page startup.
    forceReconnect() {
        console.log('[Theatre] forceReconnect() — closing existing sockets and reconnecting immediately.');
        // Mark as disconnected so the existing onclose retry timers don't double-fire
        this._forceReconnecting = true;
        this.readerWsConnected = false;
        this.sceneWsConnected = false;
        try { if (this.readerWs) this.readerWs.close(); } catch(e) {}
        try { if (this.sceneWs) this.sceneWs.close(); } catch(e) {}
        // Give the close frames a tick to flush, then reconnect immediately
        setTimeout(() => {
            this._forceReconnecting = false;
            if (this._readerPort && this._updateStatusUI) {
                this.connectReader(this._readerPort, this._updateStatusUI);
            }
            if (this._scenePort && this._updateStatusUI) {
                this.connectScene(this._scenePort, this._updateStatusUI);
            }
        }, 300);
    }

    connectReader(port, updateStatusUI) {
        const urlParams = new URLSearchParams(window.location.search);
        let host = urlParams.get('host') || urlParams.get('ip') || window.location.hostname || '127.0.0.1';
        this.readerWs = new WebSocket(`ws://${host}:${port}`);

        this.readerWs.onopen = () => {
            console.log("[Theatre] Connected to Reader WS.");
            if (window.logTheatreEvent) window.logTheatreEvent("Connected to Reader WS.", false);
            this.readerWsConnected = true;
            updateStatusUI();
            // Always request config on open — the scene socket owns the authoritative merge;
            // this reader socket only extracts OBS credentials from the response.
            this.readerWs.send(JSON.stringify({ type: "request_config_state" }));
        };

        this.readerWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'alert' || data.type === 'moderation' || data.type === 'chat') {
                    this.handleEvent(data);
                } else if (data.type === 'config_state' || data.type === 'config_updated') {
                    const readerPayload = data.payload || {};
                    const readerObs = readerPayload.obs_bridge || {};
                    if (readerObs.obs_pass || readerObs.password) {
                        console.log("[Theatre] Extracted OBS credentials from Reader WebSocket:", readerObs);
                        
                        if (window.configManager) {
                            const config = window.configManager.loadConfig() || {};
                            config.obs_bridge = config.obs_bridge || {};
                            
                            let changed = false;
                            for (const key of ["ip", "port", "password", "obs_url", "obs_pass", "enabled"]) {
                                if (readerObs[key] !== undefined && config.obs_bridge[key] !== readerObs[key]) {
                                    config.obs_bridge[key] = readerObs[key];
                                    changed = true;
                                }
                            }
                            
                            if (changed) {
                                // Apply to in-memory only — index.html is read-only.
                                // config.html is the only page that persists changes to theater.json.
                                console.log("[Theatre] OBS credentials applied to IN_MEMORY_CONFIG (not saved to disk).");
                                window.configManager.IN_MEMORY_CONFIG = { ...window.configManager.IN_MEMORY_CONFIG, obs_bridge: config.obs_bridge };
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("[Theatre] Reader WS Parse Error:", err);

            }
        };

        this.readerWs.onclose = () => {
            console.log("[Theatre] Reader WS Disconnected. Retrying in 5s...");
            this.readerWsConnected = false;
            updateStatusUI();
            if (!this._forceReconnecting) {
                setTimeout(() => {
                    if (!this.readerWsConnected) {
                        this.connectReader(port, updateStatusUI);
                    }
                }, 5000);
            }
        };
    }

    connectScene(port, updateStatusUI) {
        const urlParams = new URLSearchParams(window.location.search);
        let host = urlParams.get('host') || urlParams.get('ip') || window.location.hostname || '127.0.0.1';
        this.sceneWs = new WebSocket(`ws://${host}:${port}`);

        this.sceneWs.onopen = () => {
            console.log("[Theatre] Connected to Scene WS.");
            if (window.logTheatreEvent) window.logTheatreEvent("Connected to Scene WS.", false);
            this.sceneWsConnected = true;
            updateStatusUI();
            // On index.html: reset so the server-pushed config_state (or our request) is always processed.
            // On config.html: keep hasLoadedInitialConfig as-is so unsaved edits are not overwritten on reconnect.
            const isConfigPage = window.location.pathname.includes('config.html');
            if (!isConfigPage) {
                this.hasLoadedInitialConfig = false;
            }
            // Also send an explicit request as a backup in case the server's push was missed.
            this.sceneWs.send(JSON.stringify({ type: "request_config_state" }));
            window.dispatchEvent(new Event('ws_connected'));
        };

        this.sceneWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleEvent(data);
            } catch (err) {
                console.error("[Theatre] Scene WS Parse Error:", err);
            }
        };

        this.sceneWs.onclose = () => {
            console.log("[Theatre] Scene WS Disconnected. Retrying in 5s...");
            this.sceneWsConnected = false;
            updateStatusUI();
            if (!this._forceReconnecting) {
                setTimeout(() => {
                    if (!this.sceneWsConnected) {
                        this.connectScene(port, updateStatusUI);
                    }
                }, 5000);
            }
        };
    }

    matchWildcard(pattern, target) {
        // Escape regex chars except wildcard (*), replace * with (.*) to capture
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regexStr = "^" + escaped.replace(/\*/g, '(.*)') + "$";
        const regex = new RegExp(regexStr, 'i'); // case insensitive
        return target.match(regex);
    }

    replaceVariables(text, matches, payload) {
        return window.replaceTriggerVariables(text, matches, payload);
    }

    handleEvent(data) {
        if (!data) return;

        if (data.type === 'test_object') {
            if (typeof window.spawnItem === 'function') {
                console.log("[Theatre] Received cross-page test_object message:", data.payload);
                window.spawnItem(data.payload);
            } else {
                console.warn("[Theatre] Received test_object but window.spawnItem is not available.");
            }
            return;
        }

        if (data.type === 'test_trigger') {
            console.log("[Theatre] Received cross-page test_trigger message:", data.payload);
            this.executeTriggerObj(data.payload, { username: "TestUser", tier: 1 });
            return;
        }

        if (data.type === 'targets_update') {
            if (window.targetUISync && data.payload) {
                window.targetUISync(data.payload);
            }
            return;
        }

        if (data.type === 'change_window_mode') {
            console.log("[Theatre] WebSocket requested window mode change to:", data.mode);
            if (window.qtBridge && typeof window.qtBridge.changeWindowMode === 'function') {
                window.qtBridge.changeWindowMode(data.mode);
            } else {
                console.warn("[Theatre] qtBridge.changeWindowMode is not available!");
            }
            return;
        }

        if (data.type === 'config_updated' || data.type === 'config_state' || data.type === 'theater_config_updated') {
            const isConfigPage = window.location.pathname.includes('config.html');
            if (isConfigPage && this.hasLoadedInitialConfig) {
                console.log("[Theatre] Ignoring config update on config page to prevent focus/edit loss.");
                return;
            }
            this.hasLoadedInitialConfig = true;

            // --- DIAGNOSTIC: always visible in browser console ---
            console.log(`[Theatre] *** config_state received (${data.type}) — payload keys:`, data.payload ? Object.keys(data.payload) : 'NO PAYLOAD');
            if (!window.configManager) console.error("[Theatre] *** configManager is NOT available yet!");

            if (window.configManager && data.payload) {
                console.log("[Theatre] Config updated from backend:", data.type);

                // Do not filter anything from the websocket payload
                const filteredPayload = { ...data.payload };

                if (!filteredPayload.targets || filteredPayload.targets.length === 0) {
                    if (filteredPayload.camera_tracking && Array.isArray(filteredPayload.camera_tracking.secondary_sources)) {
                        filteredPayload.targets = filteredPayload.camera_tracking.secondary_sources.map(s => {
                            if (typeof s === 'string') return { id: s, name: s, obsSource: s };
                            return s;
                        });
                    }
                } else if (Array.isArray(filteredPayload.targets)) {
                    filteredPayload.targets = filteredPayload.targets.map(t => {
                        if (typeof t === 'string') return { id: t, name: t, obsSource: t };
                        return t;
                    });
                }

                // index.html is READ-ONLY: just merge the server payload into memory.
                // config.html is the only page that writes back to theater.json.
                window.configManager.IN_MEMORY_CONFIG = { 
                    ...window.configManager.IN_MEMORY_CONFIG, 
                    ...filteredPayload 
                };

                // On index.html: read from localStorage as a fallback for any objects
                // whose media data was missing in the server payload (read-only operation).
                if (!isConfigPage) {
                    const objectsRestored = window.configManager.restoreObjectsFromLocal();
                    if (objectsRestored) {
                        console.log("[Theatre] Objects supplemented from localStorage cache.");
                    }
                }

                // On config.html: let Alpine pick up the restored objects for the UI
                if (isConfigPage) {
                    window.dispatchEvent(new CustomEvent('config-updated', { detail: window.configManager.IN_MEMORY_CONFIG }));
                }
                
                // Dynamically re-render elements on screen if new layouts/triggers arrived from theater.json
                if (typeof window.initUIElements === 'function') {
                    console.log("[Theatre] Layout update detected. Re-rendering overlay elements...");
                    try { window.initUIElements(); } catch(e) { console.error("Error re-rendering UI elements:", e); }
                }
                
                // If direct OBS connection is enabled, automatically connect using current credentials
                const ob = window.configManager.IN_MEMORY_CONFIG.obs_bridge;
                if (window.obsBridge && ob && ob.enabled) {
                    console.log("[Theatre] Auto-connecting to OBS via backend configuration:", ob.ip, ob.port);
                    window.obsBridge.connect(ob.ip, ob.port, ob.password);
                }
            }
            return;
        }


        let eventStringMatch = "";
        let payloadData = data; 

        // StreamerAssistant sends BOTH an 'alert' and a 'moderation' event for a single action.
        // We ignore 'alert' and rely exclusively on the SAMMI 'moderation' payload to prevent duplicate double-spawns.
        if (data.type === 'alert') {
            return;
        } else if (data.type === 'moderation') {
            payloadData = data.payload || {};
            eventStringMatch = payloadData.trigger || "";
        }

        // Fallback for events if StreamerAssistant doesn't wrap them in a type
        if (!eventStringMatch) {
            eventStringMatch = payloadData.trigger || payloadData.event || "";
        }

        // console.log("[Theatre] Incoming WS Data:", data);
        // console.log("[Theatre] Evaluated string for matching:", eventStringMatch);

        if (eventStringMatch !== "") {
            // Deduplicate identical payloads across WebSockets
            const payloadStr = JSON.stringify(payloadData);
            const now = Date.now();
            this.recentEvents = this.recentEvents || [];
            this.recentEvents = this.recentEvents.filter(e => now - e.time < 2000);
            
            if (this.recentEvents.some(e => e.payload === payloadStr)) {
                console.log("[Theatre] Ignoring duplicate event across WebSockets:", eventStringMatch);
                return;
            }
            this.recentEvents.push({ payload: payloadStr, time: now });

            if (window.logTheatreEvent) window.logTheatreEvent(`Received Event: "${eventStringMatch}"`, false);
        }

        // Custom Parallax Calibration Routine
        if (eventStringMatch === "!calibrate" || eventStringMatch.toLowerCase().includes("calibrate parallax")) {
            console.log("[Theatre] Triggering Parallax Calibration...");
            if (window.obsBridge && window.obsBridge.connected) {
                window.obsBridge.calibrateParallaxFilters();
            } else {
                console.warn("[Theatre] obsBridge is not connected! Cannot calibrate parallax.");
            }
            return;
        }
        
        // Pass off to standalone OBS Layer Animations Engine
        if (window.obsAnimationsEngine) {
            window.obsAnimationsEngine.handleTrigger(eventStringMatch, payloadData);
        }

        if (eventStringMatch && typeof window.getTheatreConfig === 'function') {
            const config = window.getTheatreConfig();
            // 1b. New Trigger Array mapping
            if (config && config.triggers) {
                config.triggers.forEach(trig => {
                    if (!trig.events) return;
                    
                    const eventsArr = trig.events.split(',').map(s => s.trim()).filter(s => s);
                    let isMatch = false;
                    let wildcards = [];
                    let matchedPattern = "";

                    for (let pattern of eventsArr) {
                        const matchResult = this.matchWildcard(pattern, eventStringMatch);
                        if (matchResult) {
                            isMatch = true;
                            matchedPattern = pattern;
                            // slice(1) gets capture groups
                            wildcards = matchResult.slice(1);
                            break;
                        }
                    }

                    if (isMatch) {
                        console.log("[Theatre] Trigger subsystem match found:", trig.events);
                        
                        if (window.logTheatreEvent) {
                            window.logTheatreEvent(`Match Found! Pattern: "${matchedPattern}"`, false);
                        }

                        this.executeTriggerObj(trig, payloadData, wildcards);
                    }
                });
            }
        }
    }

    executeTriggerObj(trig, payloadData = {}, wildcards = []) {
        console.log("[Theatre] Executing trigger:", trig.id);

        if (!this.triggerQueue) this.triggerQueue = Promise.resolve();

        this.triggerQueue = this.triggerQueue.then(async () => {
            let maxDuration = 0;
            if (trig.obsActions && trig.obsActions.length > 0) {
                for (const action of trig.obsActions) {
                    if (action.duration && action.duration > maxDuration) {
                        maxDuration = action.duration;
                    }
                }
            }

            const config = typeof window.getTheatreConfig === 'function' ? window.getTheatreConfig() : null;

            let payload = {
                id: trig.id,
                delay: trig.delay || 0,
                payloadData: payloadData,
                wildcards: wildcards
            };

            if (trig.objectId && config && config.objects) {
                const linkedObj = config.objects.find(o => o.id === trig.objectId);
                if (linkedObj) {
                    payload = { ...linkedObj, ...payload };
                    payload.delay = trig.delay !== undefined ? trig.delay : (linkedObj.delay || 0);
                } else {
                    console.warn("[Theatre] Trigger referenced object that no longer exists:", trig.objectId);
                }
            }

            if (payload.type) {
                let targetToUse = (trig.target !== undefined && trig.target !== '') ? trig.target : (payload.target || '');

                // The trigger target dropdown stores t.id (UUID), but TargetSystem/TargetUI
                // look up targets by their human-readable name. Resolve UUID → name here.
                if (config && config.targets && targetToUse && targetToUse !== 'avatar') {
                    const resolvedTarget = config.targets.find(t => t.id === targetToUse || t.name === targetToUse);
                    if (resolvedTarget && resolvedTarget.name) {
                        targetToUse = resolvedTarget.name;
                    }
                }

                if (payload.type === 'staticimage') {
                    payload.target = this.replaceVariables(targetToUse, wildcards, payloadData);
                } else {
                    payload.target = this.replaceVariables(targetToUse, wildcards, payloadData);
                    payload.speed = (trig.speed !== undefined && trig.speed !== '') ? trig.speed : payload.speed;

                    let amountToUse = (trig.amount !== undefined && String(trig.amount).trim() !== '') ? trig.amount : (payload.amount !== undefined ? payload.amount : '1');
                    let rawAmount = this.replaceVariables(String(amountToUse), wildcards, payloadData);
                    let parsedAmount = parseInt(rawAmount, 10);
                    payload.amount = (!isNaN(parsedAmount) && parsedAmount > 0) ? parsedAmount : 1;

                    if (trig.repeatDelay !== undefined) {
                        payload.repeatTime = trig.repeatDelay;
                    }

                    if (trig.reactBounce !== undefined) {
                        payload.bounceUntilLast = trig.reactBounce;
                    }
                }
                
                if (trig.obsActions && trig.obsActions.length > 0) {
                    payload.obsActions = trig.obsActions;
                }

                if (trig.collisionActions && trig.collisionActions.length > 0) {
                    payload.collisionActions = trig.collisionActions;
                }

                if (trig.lastCollisionActions && trig.lastCollisionActions.length > 0) {
                    payload.lastCollisionActions = trig.lastCollisionActions;   
                }

                if (typeof this.spawnCallback === 'function') {
                    console.log("[DEBUG] Calling spawnCallback via TriggerSystem:", payload);
                    this.spawnCallback(payload);
                } else {
                    console.error("[DEBUG] Error: this.spawnCallback is not a valid callback!", typeof this.spawnCallback);
                }
            }

            // Excecute 'On Start' OBS Actions directly from the Trigger
            if (trig.obsActions && trig.obsActions.length > 0 && window.obsBridge && typeof window.obsBridge.executeActions === 'function') {
                const actionContext = {
                    collisionActions: trig.collisionActions,
                    lastCollisionActions: trig.lastCollisionActions
                };
                if (payload.delay && payload.delay > 0) {
                    setTimeout(() => {
                        window.obsBridge.executeActions(trig.obsActions, payloadData, wildcards, actionContext).catch(err => {
                            console.error("[Theatre] Trigger OBS On Start Action batch failed:", err);
                        });
                    }, payload.delay);
                } else {
                    window.obsBridge.executeActions(trig.obsActions, payloadData, wildcards, actionContext).catch(err => {
                        console.error("[Theatre] Trigger OBS On Start Action batch failed:", err);
                    });
                }
            }

            await new Promise(r => setTimeout(r, maxDuration));
        }).catch(err => {
            console.error("[Theatre] Trigger queue execution error:", err);
        });
    }
}



