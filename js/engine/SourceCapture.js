/**
 * SourceCapture.js
 * 
 * Captures a screenshot of the camera feed source (e.g. 'nose') from OBS,
 * crops it to the exact tracked bounding box coordinates of the selected target,
 * applies a brightness cutout, resizes the cropped asset to fit within 256x256,
 * and returns a cropped base64 PNG ready for spawning.
 */

class SourceCapture {

    /**
     * Capture the camera feed from OBS and crop it to the target's bounding box.
     * @param {object} obj - The snapshot object config from the inventory
     * @returns {Promise<{imageSrc: string, width: number, height: number}|null>}
     */
    async captureForObject(obj) {
        const sourceName = obj.obsSource;
        if (!sourceName) {
            const errMsg = 'No OBS source configured on snapshot object.';
            console.warn('[SourceCapture]', errMsg);
            if (window.logTheatreEvent) {
                window.logTheatreEvent('[SourceCapture] ' + errMsg, true);
            }
            return null;
        }

        // Find target name by matching the obsSource
        let targetName = null;
        if (window.configManager && window.configManager.IN_MEMORY_CONFIG && window.configManager.IN_MEMORY_CONFIG.targets) {
            const tgt = window.configManager.IN_MEMORY_CONFIG.targets.find(t => t.obsSource === sourceName);
            if (tgt) {
                targetName = tgt.name;
            }
        }

        const brightnessThreshold = typeof obj.brightnessThreshold === 'number' ? obj.brightnessThreshold : 40;

        // 1. Fetch current frame from HTTP snapshot endpoint
        const snapshotUrl = 'http://127.0.0.1:41838/snapshot';
        let screenshotImg = null;
        try {
            screenshotImg = await new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload  = () => resolve(img);
                img.onerror = () => reject(new Error('Failed to load snapshot from camera tracker HTTP server.'));
                img.src = `${snapshotUrl}?t=${Date.now()}`;
            });
        } catch (e) {
            const errMsg = `Failed to retrieve camera feed snapshot: ${e.message || e}`;
            console.error('[SourceCapture]', errMsg);
            if (window.logTheatreEvent) {
                window.logTheatreEvent(errMsg, true);
            }
            return null;
        }

        if (!screenshotImg) {
            return null;
        }

        // 2. Load screenshot into offscreen canvas

        const SW = screenshotImg.width;
        const SH = screenshotImg.height;

        const workCanvas = document.createElement('canvas');
        workCanvas.width  = SW;
        workCanvas.height = SH;
        const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
        wCtx.drawImage(screenshotImg, 0, 0, SW, SH);

        // 3. Find target bounds to crop (use $container in $theater_master)
        let targetBounds = null;
        let hasBounds = false;

        // Try to query OBS WebSocket for the container scene item transform first (e.g. '$Chat' or '$nose')
        if (window.obsBridge && window.obsBridge.connected) {
            try {
                const containerName = `$${sourceName}`; // e.g. '$Chat' or '$nose'
                const listResp = await window.obsBridge.sendRequest('GetSceneItemList', {
                    sceneName: '$theater_master'
                });
                
                if (listResp && listResp.requestStatus && listResp.requestStatus.result && listResp.responseData && listResp.responseData.sceneItems) {
                    const item = listResp.responseData.sceneItems.find(si => si.sourceName === containerName);
                    if (item) {
                        const transformResp = await window.obsBridge.sendRequest('GetSceneItemTransform', {
                            sceneName: '$theater_master',
                            sceneItemId: item.sceneItemId
                        });
                        if (transformResp && transformResp.requestStatus && transformResp.requestStatus.result && transformResp.responseData && transformResp.responseData.sceneItemTransform) {
                            const transform = transformResp.responseData.sceneItemTransform;
                            if (transform.width > 0 && transform.height > 0) {
                                const scaleX = SW / 1920;
                                const scaleY = SH / 1080;
                                targetBounds = {
                                    minX: Math.max(0, Math.floor(transform.positionX * scaleX)),
                                    minY: Math.max(0, Math.floor(transform.positionY * scaleY)),
                                    width: Math.min(SW, Math.ceil(transform.width * scaleX)),
                                    height: Math.min(SH, Math.ceil(transform.height * scaleY))
                                };
                                hasBounds = true;
                                console.log(`[SourceCapture] Successfully retrieved grid cell bounds for container '${containerName}':`, targetBounds);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('[SourceCapture] Failed to query container scene transform:', e);
            }
        }

        // Fallback to manual grid cell calculation if OBS query fails
        if (!hasBounds) {
            const camCfg = window.configManager.IN_MEMORY_CONFIG.camera_tracking || {};
            const targets = [];
            if (camCfg.avatar_source) {
                targets.push(camCfg.avatar_source);
            }
            const secondaries = camCfg.secondary_sources || [];
            for (const s of secondaries) {
                if (s && !targets.includes(s)) {
                    targets.push(s);
                }
            }

            const numTargets = targets.length;
            if (numTargets > 0) {
                let gridSize = 1;
                if (numTargets <= 1) gridSize = 1;
                else if (numTargets <= 4) gridSize = 2;
                else if (numTargets <= 9) gridSize = 3;
                else gridSize = 4;

                const targetIndex = targets.indexOf(sourceName);
                if (targetIndex !== -1) {
                    const col = targetIndex % gridSize;
                    const row = Math.floor(targetIndex / gridSize);
                    const cellW = 1920 / gridSize;
                    const cellH = 1080 / gridSize;
                    const offsetX = col * cellW;
                    const offsetY = row * cellH;

                    const scaleX = SW / 1920;
                    const scaleY = SH / 1080;

                    targetBounds = {
                        minX: Math.max(0, Math.floor(offsetX * scaleX)),
                        minY: Math.max(0, Math.floor(offsetY * scaleY)),
                        width: Math.min(SW, Math.ceil(cellW * scaleX)),
                        height: Math.min(SH, Math.ceil(cellH * scaleY))
                    };
                    console.log(`[SourceCapture] Fallback: calculated grid cell bounds for '${sourceName}':`, targetBounds);
                }
            }
        }

        let minX = 0, minY = 0, cropW = SW, cropH = SH;
        if (targetBounds) {
            minX = targetBounds.minX;
            minY = targetBounds.minY;
            cropW = targetBounds.width;
            cropH = targetBounds.height;
        }

        if (cropW <= 0 || cropH <= 0) {
            console.warn('[SourceCapture] Target crop area is empty.');
            return null;
        }

        // Get image data for the target area and apply brightness cutout
        const imgData = wCtx.getImageData(minX, minY, cropW, cropH);
        const pixels  = imgData.data;
        this._applyBrightnessCutout(pixels, cropW, cropH, brightnessThreshold);
        wCtx.putImageData(imgData, minX, minY);

        // Find bounding box of visible pixels within the target area
        const bounds = this._findBounds(pixels, cropW, cropH);
        if (bounds) {
            minX = minX + bounds.minX;
            minY = minY + bounds.minY;
            cropW = bounds.maxX - bounds.minX + 1;
            cropH = bounds.maxY - bounds.minY + 1;
        }

        // 4. Draw cropped region onto final canvas resized to fit within 256x256
        const maxDim = 256;
        const ratio  = cropW / cropH;
        let outW = maxDim;
        let outH = maxDim;
        if (cropW >= cropH) {
            outW = maxDim;
            outH = Math.max(1, Math.round(maxDim / ratio));
        } else {
            outH = maxDim;
            outW = Math.max(1, Math.round(maxDim * ratio));
        }

        const outCanvas = document.createElement('canvas');
        outCanvas.width  = outW;
        outCanvas.height = outH;
        const outCtx = outCanvas.getContext('2d');
        outCtx.drawImage(workCanvas, minX, minY, cropW, cropH, 0, 0, outW, outH);

        const dataUrl = outCanvas.toDataURL('image/png');

        // Send cropped screenshot to backend for debugging
        if (window.theatreWs && window.theatreWs.ws) {
            window.theatreWs.ws.send(JSON.stringify({
                type: "save_debug_screenshot",
                filename: `debug_cropped_${sourceName}.png`,
                image_data: dataUrl
            }));
        }

        return { imageSrc: dataUrl, width: outW, height: outH };
    }

    /**
     * Applies a brightness-threshold cutout in-place on a flat Uint8ClampedArray of RGBA pixels.
     * Pixels whose perceived brightness is below the threshold are made transparent.
     */
    _applyBrightnessCutout(pixels, w, h, threshold) {
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            // Perceived brightness (ITU-R BT.601 luma)
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            if (brightness < threshold) {
                pixels[i + 3] = 0; // transparent
            }
        }
    }

    /**
     * Finds the bounding box of non-transparent pixels.
     * Returns null if the image is entirely transparent.
     */
    _findBounds(pixels, w, h) {
        let minX = w, minY = h, maxX = 0, maxY = 0;
        let found = false;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const alpha = pixels[(y * w + x) * 4 + 3];
                if (alpha > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    found = true;
                }
            }
        }
        return found ? { minX, minY, maxX, maxY } : null;
    }
}

window.sourceCapture = new SourceCapture();
