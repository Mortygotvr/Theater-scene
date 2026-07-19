ObsBridge.prototype.getSceneList = async function() {
        if (!this.connected) return;
        
        // Also fetch video settings to grab actual OBS canvas resolution
        this.ws.send(JSON.stringify({
            op: 6,
            d: {
                requestType: "GetVideoSettings",
                requestId: "get_video_settings"
            }
        }));
        
        const targetSelect = document.getElementById("parallax-target-scene");
        if (targetSelect) {
            let savedScene = null;
            if (window.getTheatreConfig) {
                const cfg = window.getTheatreConfig();
                savedScene = cfg.parallax?.targetScene || null;
            }
            await window.ObsDropbox.populate(targetSelect, 'scene', null, savedScene);
            if (savedScene) {
                this.getSceneItemListForDropdowns(savedScene);
            }

            // BACKGROUND PRIMING: Fetch all sources for all scenes now 
            // so that Trigger UI dropdowns are instant on load.
            const resp = await this.sendRequest("GetSceneList");
            if (resp && resp.responseData && resp.responseData.scenes) {
                resp.responseData.scenes.forEach(s => {
                    window.ObsDropbox.populate(null, 'source', s.sceneName);
                });
            }
            
            if (!targetSelect.dataset.bound) {
                targetSelect.dataset.bound = 'true';
                targetSelect.addEventListener('change', (e) => {
                    this.getSceneItemListForDropdowns(e.target.value);
                });
            }
        }
    }


ObsBridge.prototype.getSceneItemListForDropdowns = async function(sceneName) {
        if (!this.connected || !sceneName) return;
        
        const cfg = window.getTheatreConfig ? window.getTheatreConfig() : null;
        for (let i = 1; i <= 5; i++) {
            const select = document.getElementById(`layer_name_${i}`);
            const savedLayer = cfg && cfg.parallax && cfg.parallax.layers && cfg.parallax.layers[i-1] ? cfg.parallax.layers[i-1].name : null;
            await window.ObsDropbox.populate(select, 'source', sceneName, savedLayer);
        }
    }


