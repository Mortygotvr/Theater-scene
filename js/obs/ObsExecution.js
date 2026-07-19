ObsBridge.prototype.executeActions = async function(actions, payloadData = {}, wildcards = [], context = {}) {
        if (!this.connected || !this.ws || !actions || !Array.isArray(actions)) return;

        for (const action of actions) {
            if (!action.type || (!action.source && action.type !== 'throw_object')) continue;
            
            console.log(`[OBS Bridge] Executing action: ${action.type} -> ${action.source || action.objectId}`, action);

            try {
                if (action.delay > 0) {
                    await new Promise(r => setTimeout(r, action.delay));
                }

                if (action.type === 'throw_object') {
                    if (action.objectId && window.configManager) {
                        const config = window.configManager.loadConfig();
                        const linkedObj = config.objects ? config.objects.find(o => o.id === action.objectId) : null;
                        if (linkedObj) {
                            let payload = { ...linkedObj };

                            // Resolve collision sound path if specified
                            if (action.collisionSound) {
                                const audioObj = config.objects ? config.objects.find(o => o.id === action.collisionSound && o.type === 'audio') : null;
                                if (audioObj && audioObj.startSound) {
                                    payload.collisionSound = audioObj.startSound;
                                }
                            }

                            // Variable replacement on target
                            let targetToUse = (action.target !== undefined && action.target !== '') ? action.target : (payload.target || 'avatar');
                            payload.target = window.replaceTriggerVariables ? window.replaceTriggerVariables(targetToUse, wildcards, payloadData) : targetToUse;

                            // Variable replacement on amount
                            let amountToUse = (action.amount !== undefined && String(action.amount).trim() !== '') ? action.amount : (payload.amount !== undefined ? payload.amount : '1');
                            let rawAmount = window.replaceTriggerVariables ? window.replaceTriggerVariables(String(amountToUse), wildcards, payloadData) : String(amountToUse);
                            let parsedAmount = parseInt(rawAmount, 10);
                            payload.amount = (!isNaN(parsedAmount) && parsedAmount > 0) ? parsedAmount : 1;

                            // Speed
                            let speedToUse = (action.speed !== undefined && action.speed !== '') ? action.speed : payload.speed;
                            payload.speed = speedToUse;

                            // Repeat Delay
                            if (action.repeatDelay !== undefined) {
                                payload.repeatTime = action.repeatDelay;
                            }

                            // Pass trigger collision actions
                            if (context.collisionActions) {
                                payload.collisionActions = context.collisionActions;
                            }
                            if (context.lastCollisionActions) {
                                payload.lastCollisionActions = context.lastCollisionActions;
                            }

                            // Pass context payloadData / wildcards
                            payload.payloadData = payloadData;
                            payload.wildcards = wildcards;

                            if (typeof window.spawnItem === 'function') {
                                window.spawnItem(payload);
                            }
                        } else {
                            console.warn(`[OBS Bridge] Could not find object ID to throw: ${action.objectId}`);
                        }
                    }
                    continue;
                }

                if (action.type === 'play_audio') {
                    if (action.source && window.configManager) {
                        const config = window.configManager.loadConfig();
                        const audioObj = config.objects ? config.objects.find(o => o.id === action.source && o.type === 'audio') : null;
                        if (audioObj && audioObj.startSound) {
                            const audio = new Audio(audioObj.startSound);
                            audio.play().catch(e => console.warn("[OBS Bridge] Audio play blocked", e));
                        } else {
                            console.warn(`[OBS Bridge] Could not find audio object ID: ${action.source}`);
                        }
                    }
                    continue;
                }

                // Pre-fetch actual scene name if none was provided
                let actualScene = action.scene;
                if (!actualScene) {
                     const activeResp = await this.sendRequest("GetCurrentProgramScene");
                     if (activeResp && activeResp.responseData) {
                         actualScene = activeResp.responseData.currentProgramSceneName;
                     }
                }
                const itemId = await this.getSceneItemId(actualScene, action.source);

                if (action.type === 'toggle_source') {
                    if (itemId === null) {
                        console.warn(`[OBS Bridge] Cannot toggle source, could not find SceneItemId for ${action.source}`);
                        continue;
                    }
                    
                    // Turn on source
                    await this.sendRequest("SetSceneItemEnabled", {
                        sceneName: actualScene,
                        sceneItemId: itemId,
                        sceneItemEnabled: true
                    });
                    
                    // Wait duration then turn off
                    if (action.duration > 0) {
                        setTimeout(async () => {
                            await this.sendRequest("SetSceneItemEnabled", {
                                sceneName: actualScene,
                                sceneItemId: itemId,
                                sceneItemEnabled: false
                            });
                        }, action.duration);
                    }
                } 
                else if (action.type === 'toggle_filter') {
                    if (!action.filter) continue;
                    
                    // Turn on filter
                    await this.sendRequest("SetSourceFilterEnabled", {
                        sourceName: action.source,
                        filterName: action.filter,
                        filterEnabled: true
                    });
                    
                    // Wait duration then turn off
                    if (action.duration > 0) {
                        setTimeout(async () => {
                            await this.sendRequest("SetSourceFilterEnabled", {
                                sourceName: action.source,
                                filterName: action.filter,
                                filterEnabled: false
                            });
                        }, action.duration);
                    }
                }
                else if (action.type === 'set_value') {
                    if (!action.filter || !action.settingKey) continue;
                    
                    // Restore original value after duration if duration > 0
                    let originalVal = null;
                    if (action.duration > 0) {
                        const curSettings = await this.sendRequest("GetSourceFilter", {
                            sourceName: action.source,
                            filterName: action.filter
                        });
                        if (curSettings && curSettings.responseData && curSettings.responseData.filterSettings) {
                            originalVal = curSettings.responseData.filterSettings[action.settingKey];
                        }
                    }

                    const settingsPayload = {};
                    settingsPayload[action.settingKey] = action.value;

                    await this.sendRequest("SetSourceFilterSettings", {
                        sourceName: action.source,
                        filterName: action.filter,
                        filterSettings: settingsPayload,
                        overlay: true
                    });

                    if (action.duration > 0 && originalVal !== null) {
                        setTimeout(async () => {
                            const restorePayload = {};
                            restorePayload[action.settingKey] = originalVal;
                            await this.sendRequest("SetSourceFilterSettings", {
                                sourceName: action.source,
                                filterName: action.filter,
                                filterSettings: restorePayload,
                                overlay: true
                            });
                        }, action.duration);
                    }
                }
                else if (action.type === 'set_crop') {
                    // Custom OBS action: Takes a Hitbox string (e.g. "avatar") OR X,Y,W,H manually
                    if (itemId === null) {
                        console.warn(`[OBS Bridge] Cannot crop, could not find SceneItemId for ${action.source}`);
                        continue;
                    }
                    
                    let domX = 0, domY = 0, domW = 0, domH = 0;
                    let hitboxFound = false;
                    let isDomSpace = false;
                    const valStr = String(action.value || '').trim();
                    
                    // Check if it's a named Python-driven hitbox (avatar or any other target)
                    if (window.targetUI) {
                        const bounds = window.targetUI.getTargetBounds(valStr);
                        if (bounds) {
                            const [bx, by, bw, bh] = bounds;
                            domX = bx; domY = by; domW = bw; domH = bh;
                            hitboxFound = true;
                            isDomSpace = true;
                        }
                    }
                    // Check explicit Targets (comes from UI rendered rects)
                    else if (window.theatreWs && window.theatreWs.obsRectCache && window.theatreWs.obsRectCache[valStr]) {
                        const rect = window.theatreWs.obsRectCache[valStr];
                        domX = rect.left;
                        domY = rect.top;
                        domW = rect.width;
                        domH = rect.height;
                        hitboxFound = true;
                        isDomSpace = true;
                    } 
                    
                    let targetX = domX, targetY = domY, targetW = domW, targetH = domH;

                    if (!hitboxFound && valStr) {
                        // Manually typed comma-separated fallback (assumed to already be absolute OBS Coordinates)
                        const parts = valStr.split(',').map(s => parseInt(s.trim()));
                        if (parts.length >= 4 && !isNaN(parts[0])) {
                            targetX = parts[0]; targetY = parts[1]; targetW = parts[2]; targetH = parts[3];
                            hitboxFound = true;
                            isDomSpace = false;
                        }
                    }

                    if (!hitboxFound) {
                        console.warn(`[OBS Bridge] Crop action failed, invalid hitbox target or dimensions: ${valStr}`);
                        continue;
                    }

                    // Translate Webpage DOM coordinates back to OBS Canvas Native Coordinates
                    if (isDomSpace) {
                        const cw = this.obsCanvasWidth || window.innerWidth;
                        const ch = this.obsCanvasHeight || window.innerHeight;
                        const canvasScaleX = cw / window.innerWidth;
                        const canvasScaleY = ch / window.innerHeight;

                        targetX = domX * canvasScaleX;
                        targetY = domY * canvasScaleY;
                        targetW = domW * canvasScaleX;
                        targetH = domH * canvasScaleY;
                    }

                    // Look for a Crop/Pad filter natively on the source
                    const filterResp = await this.sendRequest("GetSourceFilterList", { sourceName: action.source });
                    let cropFilterName = null;
                    if (filterResp && filterResp.responseData && filterResp.responseData.filters) {
                        const cropFilter = filterResp.responseData.filters.find(f => f.filterKind === "crop_filter");
                        if (cropFilter) cropFilterName = cropFilter.filterName;
                    }

                    if (cropFilterName) {
                        // Translation of Coordinates:
                        // 1. Get the source's native alignment, scaling, and offset to translate canvas pixels back to texture pixels.
                        const curTransform = await this.sendRequest("GetSceneItemTransform", {
                            sceneName: actualScene,
                            sceneItemId: itemId
                        });

                        let filterLeft = targetX;
                        let filterTop = targetY;
                        let filterWidth = targetW;
                        let filterHeight = targetH;

                        if (curTransform && curTransform.responseData && curTransform.responseData.sceneItemTransform) {
                            const transform = curTransform.responseData.sceneItemTransform;
                            const sourceW = transform.sourceWidth;
                            const sourceH = transform.sourceHeight;
                            
                            const origScaleX = transform.scaleX || 1.0;
                            const origScaleY = transform.scaleY || 1.0;
                            
                            // Transform alignment offset correction
                            // OBS Scene alignment flags adjust where positionX and positionY actually point
                            const align = transform.alignment;
                            let origX = transform.positionX || 0;
                            let origY = transform.positionY || 0;
                            
                            if (align === 0 || align === 4 || align === 8) {
                                origX -= (sourceW * origScaleX) / 2;
                            } else if (align === 2 || align === 6 || align === 10) {
                                origX -= (sourceW * origScaleX);
                            }
                            
                            if (align === 0 || align === 1 || align === 2) {
                                origY -= (sourceH * origScaleY) / 2;
                            } else if (align === 8 || align === 9 || align === 10) {
                                origY -= (sourceH * origScaleY);
                            }

                            // OBS standard mathematical mapping
                            // We calculate distance from the source's native top-left.
                            const deltaX = targetX - origX;
                            const deltaY = targetY - origY;

                            // Calculate pixels to cut off from Top-Left
                            filterLeft = Math.max(0, Math.round(deltaX / origScaleX));
                            filterTop = Math.max(0, Math.round(deltaY / origScaleY));
                            
                            // Convert the target dimensions to unscaled texture space dimensions
                            const boxW = Math.round(targetW / origScaleX);
                            const boxH = Math.round(targetH / origScaleY);

                            // Calculate pixels to cut off from Bottom-Right
                            filterWidth = Math.max(0, sourceW - (filterLeft + boxW));
                            filterHeight = Math.max(0, sourceH - (filterTop + boxH));
                        }

                        // Pass exact crop values to the filter. 
                        await this.sendRequest("SetSourceFilterSettings", {
                            sourceName: action.source,
                            filterName: cropFilterName,
                            filterSettings: {
                                left: filterLeft, right: filterWidth, top: filterTop, bottom: filterHeight
                            },
                            overlay: true
                        });
                        
                        // User requested to try the transform along with the crop, placing the cropped visual at the exact tracker bounds.
                        if (curTransform && curTransform.responseData && curTransform.responseData.sceneItemTransform) {
                            const transform = curTransform.responseData.sceneItemTransform;
                            
                            const originalPosX = transform.positionX;
                            const originalPosY = transform.positionY;

                            // Keep it simple: Just move the source to snap directly to the target X/Y coordinates
                            await this.sendRequest("SetSceneItemTransform", {
                                sceneName: actualScene,
                                sceneItemId: itemId,
                                sceneItemTransform: {
                                    positionX: targetX,
                                    positionY: targetY
                                }
                            });

                            if (action.duration > 0) {
                                setTimeout(async () => {
                                    await this.sendRequest("SetSceneItemTransform", {
                                        sceneName: actualScene,
                                        sceneItemId: itemId,
                                        sceneItemTransform: {
                                            positionX: originalPosX,
                                            positionY: originalPosY
                                        }
                                    });
                                    await this.sendRequest("SetSourceFilterSettings", {
                                        sourceName: action.source,
                                        filterName: cropFilterName,
                                        filterSettings: { left: 0, right: 0, top: 0, bottom: 0 },
                                        overlay: true
                                    });
                                }, action.duration);
                            }
                        } else {
                            if (action.duration > 0) {
                                setTimeout(async () => {
                                    await this.sendRequest("SetSourceFilterSettings", {
                                        sourceName: action.source,
                                        filterName: cropFilterName,
                                        filterSettings: { left: 0, right: 0, top: 0, bottom: 0 },
                                        overlay: true
                                    });
                                }, action.duration);
                            }
                        }
                    }
                }

            } catch (err) {
                console.error(`[OBS Bridge] Action failed: ${action.type}`, err);
            }
        }
    }

    /**
     * Helper to resolve Scene Item IDs, optionally querying current scene
     */

ObsBridge.prototype.getSceneItemId = async function(sceneName, sourceName) {
        if (!sceneName) {
             const activeResp = await this.sendRequest("GetCurrentProgramScene");
             if (activeResp && activeResp.responseData) {
                 sceneName = activeResp.responseData.currentProgramSceneName;
             }
        }
        if (!sceneName) return null;
        
        const resp = await this.sendRequest("GetSceneItemId", {
            sceneName: sceneName,
            sourceName: sourceName
        });
        
        if (resp && resp.responseData) {
            return resp.responseData.sceneItemId;
        }
        return null;
    }


