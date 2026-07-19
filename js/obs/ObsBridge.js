
// Pure JS SHA-256 — used as fallback when crypto.subtle is unavailable (e.g. file:// context)
function pureJsSha256(data) {
    const K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const len = bytes.length;
    const bitLen = len * 8;
    const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 4, bitLen >>> 0, false);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let i = 0; i < padded.length; i += 64) {
        const w = new Uint32Array(64);
        for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
        for (let j = 16; j < 64; j++) {
            const s0 = rotr(w[j-15],7) ^ rotr(w[j-15],18) ^ (w[j-15]>>>3);
            const s1 = rotr(w[j-2],17) ^ rotr(w[j-2],19) ^ (w[j-2]>>>10);
            w[j] = (w[j-16] + s0 + w[j-7] + s1) >>> 0;
        }
        let [a,b,c,d,e,f,g,hh] = h;
        for (let j = 0; j < 64; j++) {
            const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
            const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
        }
        h = h.map((v,i) => (v + [a,b,c,d,e,f,g,hh][i]) >>> 0);
    }
    const out = new Uint8Array(32);
    h.forEach((v,i) => new DataView(out.buffer).setUint32(i*4, v, false));
    return out;
}

/**
 * ARCHITECTURAL NOTE: FugiTech Theatre OBS WebSocket Bridge (obs-bridge.js)
 * 
 * 1. Scope: Manages the `obs-websocket-js` style RAW JSON payload connection to OBS.
 * 2. Authentication: Implements SHA-256 base64 hashing for OBS v5 authentication challenges.
 * 3. Parallax Role: Maintains a `layerCache` of initial item positions (`GetSceneItemList`).
 * 4. Constraint Rules: 
 *    - Uses `GetVideoSettings` to query exact canvas resolution (e.g., 1920x1080).
 *    - Dispatches `SetSceneItemTransform` batch requests. 
 *    - Enforces `OBS_BOUNDS_STRETCH` during `calibrateParallaxLayers()` to reset layers exactly 
 *      to monitor size before applying relative `sendAxes(dx, dy)` tracking offsets.
 */

class ObsBridge {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.messageId = 1;
        this.layerCache = {}; // sceneName -> { layerName: { id, baseX, baseY } }
        this.requestMap = new Map(); // Store promises for unified OBS requests
        this.triggerQueue = Promise.resolve();
        this.actionQueue = Promise.resolve(); // Global queue for trigger execution
        
        // Wait for DOM to attach the connection button if it exists
        document.addEventListener('DOMContentLoaded', () => {
            const btn = document.getElementById('obs-connect-btn');
            if (btn) {
                btn.addEventListener('click', () => {
                    const ip = document.getElementById('obs-ip') ? document.getElementById('obs-ip').value : '127.0.0.1';
                    const port = document.getElementById('obs-port') ? document.getElementById('obs-port').value : '4455';
                    const pass = document.getElementById('obs-password') ? document.getElementById('obs-password').value : '';
                    this.connect(ip, port, pass);
                });
            }
        });
    }


}

ObsBridge.prototype.calibrateParallaxFilters = async function() {
    if (!this.connected) return;
    try {
        console.log("[OBS Bridge] Calibrating Parallax Filters...");
        const sceneRes = await this.sendRequest("GetSceneList");
        if (!sceneRes || !sceneRes.scenes) return;

        let sourcesToCheck = new Set();
        
        for (const scene of sceneRes.scenes) {
            const itemsRes = await this.sendRequest("GetSceneItemList", { sceneName: scene.sceneName });
            if (itemsRes && itemsRes.sceneItems) {
                for (const item of itemsRes.sceneItems) {
                    sourcesToCheck.add(item.sourceName);
                }
            }
        }
        
        let toggledCount = 0;
        for (const sourceName of sourcesToCheck) {
            const filterRes = await this.sendRequest("GetSourceFilterList", { sourceName });
            if (filterRes && filterRes.filters) {
                const pFilters = filterRes.filters.filter(f => f.filterKind === "theatre_parallax_filter" || f.filterName.toLowerCase().includes("parallax"));
                for (const filter of pFilters) {
                    // Toggle Off
                    await this.sendRequest("SetSourceFilterEnabled", {
                        sourceName: sourceName,
                        filterName: filter.filterName,
                        filterEnabled: false
                    });
                    
                    // Wait a tiny bit (50ms) to ensure it processes the disable
                    await new Promise(r => setTimeout(r, 50));
                    
                    // Toggle On
                    await this.sendRequest("SetSourceFilterEnabled", {
                        sourceName: sourceName,
                        filterName: filter.filterName,
                        filterEnabled: true
                    });
                    toggledCount++;
                    console.log(`[OBS Bridge] Parallax Calibrated on source: ${sourceName} (Filter: ${filter.filterName})`);
                }
            }
        }

        if (window.logTheatreEvent) {
             window.logTheatreEvent("Calibrated " + toggledCount + " parallax filters.", false);
        }
    } catch (e) {
        console.error("[OBS Bridge] Failed to calibrate parallax filters:", e);
    }
};
