import os
import sys
import json
import asyncio
import websockets

def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = get_base_dir()
CONFIG_FILE = os.path.join(BASE_DIR, "theater.json")
THEATER_FILE = os.path.join(BASE_DIR, "theater.json")

def load_config():
    """Load theater.json, falling back to theater.json.bak if the main file is corrupt."""
    for path in [CONFIG_FILE, CONFIG_FILE + ".bak"]:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if path.endswith(".bak"):
                        print(f"[WS Server] WARNING: theater.json was corrupt or missing — recovered from .bak")
                    return data
            except Exception as e:
                print(f"[WS Server] Could not parse {path}: {e} — trying fallback...")
    return {}

def load_theater_config():
    """Alias for load_config() — both read the same theater.json."""
    return load_config()

def save_config(new_config):
    """Atomically save config: write to .tmp, backup old file, then rename into place."""
    try:
        existing = load_config()
        for k, v in new_config.items():
            if isinstance(v, dict) and k in existing and isinstance(existing[k], dict):
                existing[k].update(v)
            else:
                existing[k] = v

        tmp_path = CONFIG_FILE + ".tmp"
        bak_path = CONFIG_FILE + ".bak"

        # 1. Write to a temp file first (safe — no partial overwrite of the real file)
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=4)
            f.flush()
            os.fsync(f.fileno())

        # 2. Keep a .bak of the last known-good file before overwriting
        if os.path.exists(CONFIG_FILE):
            try:
                import shutil
                shutil.copy2(CONFIG_FILE, bak_path)
            except Exception:
                pass

        # 3. Atomic rename: replaces theater.json in one OS operation
        os.replace(tmp_path, CONFIG_FILE)
        print(f"[WS Server] Saved theater.json config to disk (atomic).")
    except Exception as e:
        print(f"[WS Server] Error saving theater.json: {e}")

def load_complete_config_state():
    state = {
        "obs_bridge": {"obs_url": "ws://localhost:4455", "obs_pass": "", "enabled": True},
        "camera_tracking": {
            "avatar_source": "",
            "active_scene": "",
            "mode": "brightness",
            "threshold": 40,
            "chroma_r": 0,
            "chroma_g": 255,
            "chroma_b": 0,
            "secondary_sources": [],
            "fps_limit": 30
        },
        "targets": []
    }
    
    cfg = load_config()
    for k, v in cfg.items():
        state[k] = v

    # Diagnostic: log what we're about to push to clients
    obj_count = len(state.get("objects", []))
    trig_count = len(state.get("triggers", []))
    print(f"[WS Server] Config state ready: {obj_count} objects, {trig_count} triggers.")
    if obj_count == 0:
        print(f"[WS Server] WARNING: objects array is EMPTY — theater.json may be missing or corrupt.")
        
    return state



CLIENTS = set()

async def broadcast(message_dict, sender=None):
    if not CLIENTS:
        return
    payload = json.dumps(message_dict)
    dead_clients = set()
    for ws in list(CLIENTS):
        if ws == sender:
            continue
        try:
            await ws.send(payload)
        except Exception:
            dead_clients.add(ws)
    for ws in dead_clients:
        CLIENTS.discard(ws)

async def ws_register(websocket, path="/"):
    print(f"[WS Server] Client connected.")
    CLIENTS.add(websocket)
    try:
        # Immediately push the current config to the new client so index.html
        # always receives theater.json on startup without relying on the
        # request_config_state round-trip completing in time.
        try:
            current = load_complete_config_state()
            await websocket.send(json.dumps({"type": "config_state", "payload": current}))
            print(f"[WS Server] Pushed config_state to new client on connect.")
        except Exception as push_err:
            print(f"[WS Server] Failed to push initial config_state: {push_err}")

        async for message in websocket:
            try:
                data = json.loads(message)
                m_type = data.get("type")
                
                if m_type == "request_config_state":
                    current = load_complete_config_state()
                    await websocket.send(json.dumps({"type": "config_state", "payload": current}))
                    
                elif m_type == "save_config":
                    new_cfg = data.get("payload")
                    if new_cfg:
                        save_config(new_cfg)
                        await broadcast({"type": "config_updated", "payload": new_cfg}, sender=websocket)
                        await websocket.send(json.dumps({"type": "status", "message": "Configuration Saved!"}))
                        
                elif m_type == "save_theater_config":
                    payload = data.get("payload")
                    if payload:
                        save_config(payload)
                        await broadcast({"type": "theater_config_updated", "payload": payload}, sender=websocket)
                        await websocket.send(json.dumps({"type": "status", "message": "Theater Layout Saved!"}))
                        
                elif m_type == "update_obs_config":
                    new_obs_cfg = data.get("payload")
                    if new_obs_cfg is not None:
                        curr = load_config()
                        curr["obs_bridge"] = new_obs_cfg
                        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                            json.dump(curr, f, indent=4)
                        await websocket.send(json.dumps({"type": "status", "message": "OBS Configuration Saved!"}))
                        
                elif m_type == "save_debug_screenshot":
                    filename = data.get("filename", "debug_screenshot.png")
                    image_data = data.get("image_data")
                    if image_data and "," in image_data:
                        try:
                            import base64
                            base64_str = image_data.split(",")[1]
                            file_path = os.path.join(BASE_DIR, filename)
                            with open(file_path, "wb") as f:
                                f.write(base64.b64decode(base64_str))
                            print(f"[WS Server] Saved debug screenshot to {file_path}")
                        except Exception as e:
                            print(f"[WS Server] Error saving debug screenshot: {e}")

                elif m_type == "request_initial_obs":
                    current = load_complete_config_state()
                    obs_payload = {
                        "scenes": current.get("obs_scenes", []),
                        "sources": current.get("obs_sources", []),
                        "filters": current.get("obs_filters", {}),
                        "connected": False
                    }
                    await websocket.send(json.dumps({"type": "obs_info", "payload": obs_payload}))
                    await broadcast({"type": "fetch_obs_info"}, sender=websocket)
                    
                elif m_type == "client_error":
                    print(f"[Client ERROR] {data.get('message')} at {data.get('filename')}:{data.get('lineno')}\nStack: {data.get('stack')}")
                    await broadcast(data, sender=websocket)

                elif m_type == "client_log":
                    print(f"[Client LOG] {data.get('message')}")
                    await broadcast(data, sender=websocket)

                else:
                    await broadcast(data, sender=websocket)
            except Exception as e:
                print(f"[WS Server] Message Error: {e}")
    except Exception:
        pass
    finally:
        CLIENTS.discard(websocket)
        print(f"[WS Server] Client disconnected.")

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Theater Scene WebSocket Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host address to bind to")
    parser.add_argument("--port", type=int, default=41839, help="Port to run the server on")
    args = parser.parse_args()

    port = args.port
    for arg in sys.argv:
        if arg.startswith("--ws-port="):
            try: port = int(arg.split("=")[1])
            except: pass
        elif arg.startswith("--port="):
            try: port = int(arg.split("=")[1])
            except: pass

    print(f"[WS Server] Starting on ws://{args.host}:{port}")
    
    async def serve():
        async with websockets.serve(ws_register, args.host, port, max_size=104857600):
            await asyncio.Future()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        print("[WS Server] Shutting down...")

if __name__ == "__main__":
    main()
