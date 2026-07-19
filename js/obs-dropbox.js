/**
 * Universal OBS Dropbox Library
 * Dynamically loads Scenes, Sources, or Filters into ANY dropdown and remembers saved values automatically.
 */
class ObsDropbox {
    static cache = new Map(); // key -> Promise<items[]>
    
    static async populate(selectElement, type, parentName = null, overrideVal = null) {
        const bridge = window.obsBridge;
        if (!bridge) return;

        window.programmaticPopulateCounter = (window.programmaticPopulateCounter || 0) + 1;

        let currentReqId = 0;
        if (selectElement) {
            currentReqId = (parseInt(selectElement.dataset.populatingId) || 0) + 1;
            selectElement.dataset.populatingId = currentReqId;
            selectElement.dataset.populating = "true";
            selectElement.dataset.obsType = type;
            selectElement.dataset.obsParent = parentName || '';
            if (overrideVal !== null) selectElement.dataset.obsOverride = overrideVal;
        }

        try {
            let targetVal = overrideVal !== null ? overrideVal : (selectElement ? selectElement.value : null);
            let cacheKey = `${type}:${parentName || 'global'}`;

            let cachedPromise = this.cache.get(cacheKey);
            if (!cachedPromise) {
                cachedPromise = this._fetchItems(type, parentName);
                this.cache.set(cacheKey, cachedPromise);
            }

            let items = await cachedPromise;
            
            // If another populate call was initiated in the meantime, discard this stale call
            if (selectElement && parseInt(selectElement.dataset.populatingId) !== currentReqId) {
                return;
            }
            
            // Retry logic for empty results
            if (!items || items.length === 0) {
                this.cache.delete(cacheKey);
                if (bridge.connected) {
                    await new Promise(r => setTimeout(r, 200));
                    if (selectElement && parseInt(selectElement.dataset.populatingId) !== currentReqId) {
                        return;
                    }
                    items = await this._fetchItems(type, parentName);
                    if (selectElement && parseInt(selectElement.dataset.populatingId) !== currentReqId) {
                        return;
                    }
                    if (items && items.length > 0) {
                        this.cache.set(cacheKey, Promise.resolve(items));
                    }
                }
            }

            let labelKey = (type === 'scene') ? 'sceneName' : (type === 'source' ? 'sourceName' : (type === 'input' ? 'inputName' : 'filterName'));

            if (!items || items.length === 0) {
                let fallbackOpts = "";
                if (!bridge.connected) {
                    fallbackOpts = `<option value="">Waiting for OBS...</option>`;
                } else {
                    fallbackOpts = `<option value="">No ${type}s found...</option>`;
                }
                
                let hasMatch = false;
                if (targetVal && targetVal !== "") {
                    fallbackOpts += `<option value="${targetVal}" selected style="color:#ffcc00;">[Offline] ${targetVal}</option>`;
                    hasMatch = true;
                }
                
                if (selectElement && selectElement.innerHTML !== fallbackOpts) {
                    selectElement.innerHTML = fallbackOpts;
                    if (hasMatch) selectElement.value = targetVal;
                }
                return;
            }

            let opts = `<option value="">Select a ${type}...</option>`;
            let hasMatch = false;

            items.forEach(item => {
                const name = item[labelKey];
                if (!name) return;
                const isSelected = (name === targetVal) ? 'selected' : '';
                if (isSelected) hasMatch = true;
                opts += `<option value="${name}" ${isSelected}>${name}</option>`;
            });

            if (targetVal && !hasMatch && targetVal !== "") {
                opts += `<option value="${targetVal}" selected style="color:red;">[Offline] ${targetVal}</option>`;
                hasMatch = true;
            }

            if (selectElement) {
                const innerChanged = selectElement.innerHTML !== opts;
                if (innerChanged) {
                    selectElement.innerHTML = opts;
                }
                if (hasMatch && selectElement.value !== targetVal) {
                    selectElement.value = targetVal;
                    selectElement.dispatchEvent(new Event('change'));
                } else if (innerChanged) {
                    selectElement.dispatchEvent(new Event('change'));
                }
            }
        } finally {
            if (selectElement && parseInt(selectElement.dataset.populatingId) === currentReqId) {
                selectElement.dataset.populating = "false";
            }
            setTimeout(() => {
                window.programmaticPopulateCounter = Math.max(0, (window.programmaticPopulateCounter || 0) - 1);
            }, 100);
        }
    }

    static async _fetchItems(type, parentName) {
        const bridge = window.obsBridge;
        if (!bridge || !bridge.connected) return [];

        try {
            let resp;
            if (type === 'scene') {
                resp = await bridge.sendRequest("GetSceneList");
                return (resp && resp.requestStatus && resp.requestStatus.result) ? resp.responseData.scenes : [];
            } else if (type === 'input') {
                // All OBS inputs (sources) globally — no scene required
                resp = await bridge.sendRequest("GetInputList");
                return (resp && resp.requestStatus && resp.requestStatus.result) ? resp.responseData.inputs : [];
            } else if (type === 'source') {
                if (!parentName) return [];
                resp = await bridge.sendRequest("GetSceneItemList", { sceneName: parentName });
                return (resp && resp.requestStatus && resp.requestStatus.result) ? resp.responseData.sceneItems : [];
            } else if (type === 'filter') {
                if (!parentName) return [];
                resp = await bridge.sendRequest("GetSourceFilterList", { sourceName: parentName });
                return (resp && resp.requestStatus && resp.requestStatus.result) ? resp.responseData.filters : [];
            }
        } catch (e) {
            console.error(`[ObsDropbox] Fetch error for ${type}:`, e);
        }
        return [];
    }

    static clearCache() {
        this.cache.clear();
    }

    static refreshAll() {
        this.clearCache();
        document.querySelectorAll('select.obs-input').forEach(el => {
            const type = el.dataset.obsType;
            const parent = el.dataset.obsParent;
            const override = el.dataset.obsOverride || null;
            if (type) {
                this.populate(el, type, parent, override);
            }
        });
    }
}

// Global auto-refresh on connection
document.addEventListener('obsConnected', () => {
    // Wait for priming and bridge stability
    setTimeout(() => ObsDropbox.refreshAll(), 1500);
});
document.addEventListener('obsDisconnected', () => ObsDropbox.clearCache());

window.ObsDropbox = ObsDropbox;
