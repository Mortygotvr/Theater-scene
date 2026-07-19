import time

# Toggle to True to enable verbose OBS automation logs
DEBUG_AUTOMATION = False

def print(*args, **kwargs):
    if DEBUG_AUTOMATION:
        import builtins
        builtins.print(*args, **kwargs)

def setup_theatre_obs(obs):
    """
    Automates the creation of required OBS scenes and sources for the Theater system.
    """
    print("[Automation] !!! VERSION 2.0 BOOTING !!!", flush=True)
    if not obs.connected:
        print("[Automation] Cannot run setup: OBS not connected.", flush=True)
        return

    print("[Automation] Starting OBS Environment Setup...", flush=True)

    # 0. Clean Slate: Delete containers, but only CLEAR the master
    print("[Automation] Purging old automation scenes...", flush=True)
    resp = obs.call_sync("GetSceneList")
    if resp and "responseData" in resp and "scenes" in resp["responseData"]:
        old_scenes = [s["sceneName"] for s in resp["responseData"]["scenes"]]
        for s in old_scenes:
            if s == "$theater_master":
                print(f"[Automation] Clearing contents of existing {s}...", flush=True)
                items = obs.call_sync("GetSceneItemList", {"sceneName": s})
                if items and "responseData" in items and "sceneItems" in items["responseData"]:
                    for item in items["responseData"]["sceneItems"]:
                        obs.call_sync("RemoveSceneItem", {"sceneName": s, "sceneItemId": item["sceneItemId"]})
            elif s.startswith("$"):
                print(f"[Automation] Removing legacy container: {s}", flush=True)
                obs.remove_scene(s)

    # 1. Create/Ensure the Master Tracking Scene
    obs.create_scene("$theater_master")
    time.sleep(0.5)

    print(f"[Automation] OBS Setup Complete!", flush=True)
    return []

def sync_tracking_scenes(obs, config):
    """
    Ensures a corresponding tracking scene (starting with $) exists for each 
    configured tracking source. Each $ scene is a 'perfect container' with a 
    black background and the target source centered within it.
    
    Then, nests all these containers in the Theatre_Tracking scene.
    """
    if not obs or not obs.connected:
        return

    # --- CLEANUP PHASE ---
    print("[Automation] Syncing: Purging old tracking containers...", flush=True)
    resp = obs.call_sync("GetSceneList")
    if resp and "responseData" in resp and "scenes" in resp["responseData"]:
        old_scenes = [s["sceneName"] for s in resp["responseData"]["scenes"]]
        
        # 1. Clear items from master
        items = obs.call_sync("GetSceneItemList", {"sceneName": "$theater_master"})
        if items and "responseData" in items and "sceneItems" in items["responseData"]:
            for item in items["responseData"]["sceneItems"]:
                obs.call_sync("RemoveSceneItem", {"sceneName": "$theater_master", "sceneItemId": item["sceneItemId"]})
        
        # 2. Remove all $container scenes to avoid stale references
        for s in old_scenes:
            if s.startswith("$") and s != "$theater_master":
                obs.remove_scene(s)

    # Ensure main tracking hub (Master) exists
    obs.create_scene("$theater_master")
    time.sleep(0.2)

    # Identify targets
    cam_cfg = config.get("camera_tracking", {})
    print(f"[Automation] FULL CAMERA CONFIG: {cam_cfg}")
    targets = []
    avatar = cam_cfg.get("avatar_source")
    
    print("\n" + "="*60)
    print(f"!!! TRACKING SYNC INITIALIZED !!!")
    print(f"AVATAR SOURCE: {avatar}")
    
    if avatar: targets.append(avatar)
    
    secondaries = cam_cfg.get("secondary_sources", [])
    print(f"SECONDARY SOURCES: {secondaries}")
    print("="*60 + "\n", flush=True)

    for s in secondaries:
        if s and s not in targets:
            targets.append(s)

    if not targets:
        print("[Automation] No targets found to sync. Aborting.")
        return

    # Get transforms from the active scene to preserve stream-space mapping
    active_scene = cam_cfg.get("active_scene")
    source_transforms = {}
    if active_scene:
        print(f"[Automation] Fetching transforms from active scene: {active_scene}", flush=True)
        resp = obs.call_sync("GetSceneItemList", {"sceneName": active_scene})
        if resp and "responseData" in resp and "sceneItems" in resp["responseData"]:
            for item in resp["responseData"]["sceneItems"]:
                source_transforms[item["sourceName"]] = item.get("sceneItemTransform")

    print(f"[Automation] Building {len(targets)} containers in a GRID layout in $theater_master...", flush=True)
    
    import math
    num_targets = len(targets)
    # Use a square grid (2x2, 3x3, etc.) to maintain 16:9 aspect ratio per cell
    cols = math.ceil(math.sqrt(num_targets))
    if cols < 1: cols = 1
    rows = cols  # Square grid keeps cells 16:9
    
    cell_w = 1920 / cols
    cell_h = 1080 / rows
    scale = 1.0 / cols 
    
    for i, t in enumerate(targets):
        container_name = f"${t}"
        
        # 1. Create/Ensure the container scene exists
        obs.create_scene(container_name)
        
        # 2. Add the actual source and apply stream-space transform
        sid = obs.create_scene_item_sync(container_name, t)
        if sid is not None and t in source_transforms:
            full_t = source_transforms[t]
            # Only send the keys that OBS actually allows us to set
            clean_transform = {
                "positionX": full_t.get("positionX", 0),
                "positionY": full_t.get("positionY", 0),
                "scaleX":    full_t.get("scaleX", 1),
                "scaleY":    full_t.get("scaleY", 1),
                "cropTop":    full_t.get("cropTop", 0),
                "cropBottom": full_t.get("cropBottom", 0),
                "cropLeft":   full_t.get("cropLeft", 0),
                "cropRight":  full_t.get("cropRight", 0),
                "alignment":  full_t.get("alignment", 5)
            }
            print(f"[Automation] Applying 'Perfect Position' to {t} (ID: {sid}): {clean_transform}", flush=True)
            obs.set_scene_item_transform(container_name, sid, clean_transform)
        
        # 3. Add the container to the Master Tracking Hub
        sid_master = obs.create_scene_item_sync("$theater_master", container_name)
        
        # 4. Position it in the grid
        col = i % cols
        row = i // cols
        
        transform = {
            "positionX": col * cell_w,
            "positionY": row * cell_h,
            "scaleX": scale,
            "scaleY": scale,
            "boundsType": "OBS_BOUNDS_SCALE_INNER",
            "boundsWidth": cell_w,
            "boundsHeight": cell_h
        }
        
        # Apply grid positioning in Master
        if sid_master is not None:
            obs.set_scene_item_transform("$theater_master", sid_master, transform)
        
        time.sleep(0.1)

    # 5. Start Virtual Camera
    # Note: OBS v5 does not support setting the source via API yet.
    # User must manually set Virtual Camera to 'Scene' -> '$theater_master' once.
    print(f"[Automation] Starting Virtual Camera...", flush=True)
    obs.start_virtual_cam()
    print(f"[Automation] !!! REMINDER !!! Ensure OBS Virtual Camera is set to Scene: $theater_master", flush=True)
    
    print("[Automation] Master Tracking Sync Complete.", flush=True)
