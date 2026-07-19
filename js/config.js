const LS_OBJECTS_KEY = 'theatre_objects_v1';

class ConfigManager {
    constructor() {
        this.IN_MEMORY_CONFIG = { discordIP: 'localhost', objects: [], hasFloor: true };
        
        // Expose globally for legacy and overlay scripts
        window.getTheatreConfig = () => this.loadConfig();
        window.saveConfigDB_Raw = (configObj, skipSyncToBackend) => this.saveConfigDB_Raw(configObj, skipSyncToBackend);
    }

    // Persist objects (which may contain large base64 blobs) to localStorage
    _saveObjectsToLocal(objects) {
        try {
            if (Array.isArray(objects)) {
                localStorage.setItem(LS_OBJECTS_KEY, JSON.stringify(objects));
            }
        } catch (e) {
            console.warn('[Theatre] Could not save objects to localStorage:', e);
        }
    }

    // Load objects back from localStorage
    _loadObjectsFromLocal() {
        try {
            const raw = localStorage.getItem(LS_OBJECTS_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.warn('[Theatre] Could not load objects from localStorage:', e);
        }
        return null;
    }

    loadConfig() {
        return this.IN_MEMORY_CONFIG;
    }

    // Call this after merging server config to restore objects from localStorage if server has none,
    // OR if image-type objects exist but are missing their imageSrc (e.g. theater.json was saved
    // without base64 data due to a partial save or hard reboot corruption).
    restoreObjectsFromLocal() {
        const saved = this._loadObjectsFromLocal();

        // Case 1: Server returned no objects at all — restore everything from localStorage
        if (!this.IN_MEMORY_CONFIG.objects || this.IN_MEMORY_CONFIG.objects.length === 0) {
            if (saved && saved.length > 0) {
                console.log(`[Theatre] Restored ${saved.length} object(s) from localStorage (server returned empty).`);
                this.IN_MEMORY_CONFIG.objects = saved;
                return true;
            }
            return false;
        }

        // Case 2: Server returned objects but some image/audio types are missing their media data.
        // Merge the localStorage version (which has full base64) into the server objects by ID.
        if (saved && saved.length > 0) {
            const savedById = new Map(saved.map(o => [o.id, o]));
            let anyMerged = false;
            this.IN_MEMORY_CONFIG.objects = this.IN_MEMORY_CONFIG.objects.map(serverObj => {
                const needsMedia = (
                    (serverObj.type === 'image' && !serverObj.imageSrc) ||
                    (serverObj.type === 'audio' && !serverObj.startSound)
                );
                if (needsMedia && savedById.has(serverObj.id)) {
                    const localObj = savedById.get(serverObj.id);
                    console.log(`[Theatre] Merged media from localStorage for object: "${serverObj.name}" (${serverObj.type})`);
                    anyMerged = true;
                    return { ...serverObj, ...localObj }; // local wins for media fields
                }
                return serverObj;
            });
            if (anyMerged) return true;
        }

        return false;
    }


    saveConfigDB_Raw(configObj, skipSyncToBackend = false) {
        return new Promise((resolve) => {
            try {
                this.IN_MEMORY_CONFIG = { ...configObj };

                // Always persist objects to localStorage as a reliable backup
                if (Array.isArray(configObj.objects)) {
                    this._saveObjectsToLocal(configObj.objects);
                }

                if (!skipSyncToBackend && window.theatreWs && window.theatreWs.sceneWs) {
                    const toSave = JSON.parse(JSON.stringify(configObj));
                    const payload = JSON.stringify({ type: "save_config", payload: toSave });

                    if (this.saveTimeout) clearTimeout(this.saveTimeout);
                    this.saveTimeout = setTimeout(() => {
                        if (window.theatreWs.sceneWs.readyState === WebSocket.OPEN) {
                            console.log("[Theatre] Pushing settings to theater.json on backend disk...");
                            window.theatreWs.sceneWs.send(payload);
                        } else {
                            console.warn("[Theatre] Socket not open, queueing save on next open...");
                            const onOpen = () => {
                                window.theatreWs.sceneWs.send(payload);
                                window.theatreWs.sceneWs.removeEventListener('open', onOpen);
                            };
                            window.theatreWs.sceneWs.addEventListener('open', onOpen);
                        }
                    }, 300);
                }
            } catch (e) {
                console.error("Config save error:", e);
            }
            resolve();
        });
    }
}

window.configManager = new ConfigManager();