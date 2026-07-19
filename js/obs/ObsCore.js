ObsBridge.prototype.connect = async function(ip, port, password) {
        if (this.connected && this.ip === ip && this.port === port && this.password === password) {
            console.log("[OBS Bridge] Already connected to OBS at " + ip + ":" + port + " - skipping reconnect.");
            return;
        }
        this.ip = ip;
        this.port = port;
        this.password = password;

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        const statusMsg = document.getElementById('obs-status-msg');
        if (statusMsg) {
            statusMsg.innerText = `Connecting to ws://${ip}:${port}...`;
            statusMsg.style.color = '#ccc';
        }

        try {
            this.ws = new WebSocket(`ws://${ip}:${port}`);
        } catch (err) {
            if (statusMsg) {
                statusMsg.innerText = "Invalid WebSocket URL!";
                statusMsg.style.color = "#ff4444";
            }
            return;
        }

        this.ws.onopen = () => {
            console.log("[OBS Bridge] Connected to WebSocket server");
        };

        this.ws.onmessage = async (event) => {
            const msg = JSON.parse(event.data);

            if (msg.op === 0) { // Hello
                const challenge = msg.d.authentication;

                const identify = {
                    op: 1, // Identify
                    d: {
                        rpcVersion: 1,
                        eventSubscriptions: 0
                    }
                };

                if (challenge && password) {
                    try {
                        const authStr = await this.hashAuth(password, challenge.salt, challenge.challenge);
                        identify.d.authentication = authStr;
                    } catch (hashErr) {
                        console.error("[OBS Bridge] Auth hash failed:", hashErr.message);
                        if (statusMsg) {
                            statusMsg.innerText = "Auth failed: " + hashErr.message;
                            statusMsg.style.color = "#ff4444";
                        }
                        this.ws.close();
                        return;
                    }
                }

                this.ws.send(JSON.stringify(identify));
            } else if (msg.op === 2) { // Identified
                console.log("[OBS Bridge] Authenticated successfully");
                this.connected = true;
                if (statusMsg) {
                    statusMsg.innerText = "Connected!";
                    statusMsg.style.color = "#00ffcc";
                }
                
                // Await the initial scene fetch so that ObsDropbox cache is primed 
                // BEFORE the UI elements start their own population.
                await this.getSceneList();

                setTimeout(() => {
                    if (typeof this.initParallaxCache === 'function') {
                        this.initParallaxCache();
                    }
                    // Announce successful connection
                    document.dispatchEvent(new Event('obsConnected'));
                }, 1000);
            } else if (msg.op === 7) { // RequestResponse
                // Resolve any pending promises generated via sendRequest API
                if (msg.d && msg.d.requestId && this.requestMap.has(msg.d.requestId)) {
                    this.requestMap.get(msg.d.requestId).resolve(msg.d);
                    this.requestMap.delete(msg.d.requestId);
                    return;
                }
                this.handleResponse(msg.d);
            }
        };

        this.ws.onerror = (err) => {
            console.error("[OBS Bridge] WebSocket Error", err);
            if (statusMsg) {
                statusMsg.innerText = "Connection Error!";
                statusMsg.style.color = "#ff4444";
            }
        };

        this.ws.onclose = () => {
            console.log("[OBS Bridge] WebSocket Disconnected");
            this.connected = false;
            if (statusMsg && statusMsg.innerText === "Connected!") {
                statusMsg.innerText = "Disconnected";
                statusMsg.style.color = "#ff4444";
            }
        };
    }


ObsBridge.prototype.hashAuth = async function(password, salt, challenge) {
        const encoder = new TextEncoder();

        // Use crypto.subtle if available (secure context), otherwise fall back to pure JS SHA-256
        const sha256 = async (data) => {
            if (typeof crypto !== 'undefined' && crypto.subtle) {
                const buf = await crypto.subtle.digest('SHA-256', data);
                return new Uint8Array(buf);
            }
            // Pure JS SHA-256 fallback for file:// contexts
            return pureJsSha256(data);
        };

        const passSalt = encoder.encode(password + salt);
        const hash1 = await sha256(passSalt);
        const base64_1 = window.btoa(String.fromCharCode(...hash1));

        const secretChallenge = encoder.encode(base64_1 + challenge);
        const hash2 = await sha256(secretChallenge);
        const base64_2 = window.btoa(String.fromCharCode(...hash2));

        return base64_2;
    }


    /**
     * Unified OBS WebSocket Request API (Promise-based)
     * Send requests to OBS and get the response back via Promise instead of hacking the global handleResponse
     */

ObsBridge.prototype.sendRequest = async function(requestType, requestData = {}) {
        return new Promise((resolve) => {
            if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return resolve(null); // Resolve to null rather than throw so ui can display "Waiting for OBS"
            }
            
            const reqId = `req_${requestType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            this.requestMap.set(reqId, { resolve });
            
            // 5 second timeout to prevent memory leak
            setTimeout(() => {
                if (this.requestMap.has(reqId)) {
                    this.requestMap.get(reqId).resolve(null);
                    this.requestMap.delete(reqId);
                }
            }, 5000);

            this.ws.send(JSON.stringify({
                op: 6,
                d: {
                    requestType: requestType,
                    requestId: reqId,
                    requestData: requestData
                }
            }));
        });
    }


ObsBridge.prototype.handleResponse = function(responseData) {
        if (!responseData || !responseData.requestId) return;

        if (responseData.requestId === "get_video_settings") {
            const data = responseData.responseData;
            if (data && data.baseWidth && data.baseHeight) {
                this.obsCanvasWidth = data.baseWidth;
                this.obsCanvasHeight = data.baseHeight;
                console.log(`[OBS Bridge] Native Canvas Resolution: ${this.obsCanvasWidth}x${this.obsCanvasHeight}`);
            }
            return;
        }
        
        if (responseData.requestId.startsWith("init_cache_")) {
            const sceneName = responseData.requestId.replace("init_cache_", "");
            const items = responseData.responseData ? responseData.responseData.sceneItems : null;
            if (!items) return;
            
            items.forEach(item => {
                this.layerCache[sceneName][item.sourceName] = {
                    id: item.sceneItemId,
                    baseX: item.sceneItemTransform.positionX,
                    baseY: item.sceneItemTransform.positionY,
                    scaleX: item.sceneItemTransform.scaleX || 1.0,
                    scaleY: item.sceneItemTransform.scaleY || 1.0,
                    srcWidth: item.sceneItemTransform.sourceWidth,
                    srcHeight: item.sceneItemTransform.sourceHeight,
                    alignment: item.sceneItemTransform.alignment || 0
                };
            });
            console.log(`[OBS Bridge] Cached ${items.length} items for scene: ${sceneName}`);
            
            // Automatically calibrate layers to screen center to make our math baseline perfect
            if (typeof this.calibrateParallaxLayers === 'function') {
                this.calibrateParallaxLayers(sceneName);
            }
        }
    }
