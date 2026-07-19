import asyncio
import json
import os
import sys
import threading
import time
import urllib.request
import websockets
import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

try:
    import cv2
    import numpy as np
    HAS_OPENCV = True
except ImportError:
    cv2 = None
    np = None
    HAS_OPENCV = False

# Import local Vision Engine
from vision import VISION, HAS_OPENCV
from obs_client import OBSClient
import obs_automation

# --- Camera Streaming Global State ---
_camera_active = False
_camera_thread = None
_camera_index = 0
_current_frame = None
_last_targets_broadcast = 0.0
_ws_client_conn = None
_ws_loop = None

# --- OBS Client Connection & Loop ---
obs = None
_obs_bridge_started = False
_current_obs_host = None
_current_obs_port = None
_current_obs_password = None
_current_obs_enabled = None
_current_obs_active_scene = None
_current_avatar_source = None
_current_secondary_sources = None
_last_obs_connect_attempt = 0.0   # debounce: seconds since epoch
_CONNECT_TO_OBS_DEBOUNCE_SEC = 3.0  # minimum gap between connect_to_obs calls
_cached_tracker_config = {}         # in-memory cache of last loaded config

def execute_actions(actions, obs_client, data=None):
    if not actions or not obs_client or not obs_client.connected: return
    data = data or {}
    
    def replace_vars(text):
        if not isinstance(text, str): return text
        for k, v in data.items():
            if not isinstance(v, (list, dict)):
                text = text.replace(f"{{{k}}}", str(v))
        if "_matches" in data:
            for i, val in enumerate(data["_matches"]):
                text = text.replace(f"{{{i+1}}}", str(val))
        return text

    for action in actions:
        try:
            a_type = action.get("type")
            delay = action.get("delay", 0)
            duration = action.get("duration", 0)
            
            def _do(act=action):
                if delay > 0: time.sleep(delay / 1000.0)
                
                scene = replace_vars(act.get("scene"))
                source = replace_vars(act.get("source"))
                filter_name = replace_vars(act.get("filter"))
                
                if a_type == "toggle_source":
                    if scene and source:
                        obs_client.toggle_source_visibility(scene, source)
                        if duration > 0:
                            time.sleep(duration / 1000.0)
                            obs_client.toggle_source_visibility(scene, source)
                
                elif a_type == "toggle_filter":
                    if source and filter_name:
                        obs_client.toggle_filter(source, filter_name)
                        if duration > 0:
                            time.sleep(duration / 1000.0)
                            obs_client.toggle_filter(source, filter_name)
                
                elif a_type == "set_value":
                    key = act.get("settingKey")
                    raw_val = act.get("value")
                    if source and filter_name and key:
                        val = replace_vars(raw_val) if isinstance(raw_val, str) else raw_val
                        if isinstance(val, str):
                            if val.lower() == 'true': val = True
                            elif val.lower() == 'false': val = False
                            elif val.replace('.','',1).isdigit(): 
                                val = float(val) if '.' in val else int(val)
                        obs_client.set_filter_setting(source, filter_name, key, val)

            threading.Thread(target=_do, daemon=True).start()
        except Exception as e:
            print(f"[Tracker OBS Actions] Execution Error: {e}")

def connect_to_obs():
    global obs, _obs_bridge_started
    global _current_obs_host, _current_obs_port, _current_obs_password, _current_obs_enabled
    global _last_obs_connect_attempt, _cached_tracker_config

    # Debounce: skip if called too recently (prevents cascade on rapid config saves)
    now = time.time()
    if now - _last_obs_connect_attempt < _CONNECT_TO_OBS_DEBOUNCE_SEC:
        return
    _last_obs_connect_attempt = now

    cfg = _cached_tracker_config if _cached_tracker_config else load_config()
    obs_cfg = cfg.get("obs_bridge", {})
    
    obs_host = obs_cfg.get("ip")
    obs_port = int(obs_cfg.get("port", 4455))
    obs_password = obs_cfg.get("obs_pass", "") or obs_cfg.get("password", "")
    obs_enabled = obs_cfg.get("enabled", True)
    
    if not obs_host and "obs_url" in obs_cfg:
        url = obs_cfg["obs_url"]
        try:
            obs_host = url.replace("ws://", "").split(":")[0]
            if ":" in url:
                obs_port = int(url.split(":")[-1])
        except:
            obs_host = "localhost"

    # Normalize host
    if not obs_host:
        obs_host = "localhost"

    # Check if we are already connected to the exact same host/port/password/state
    if obs and obs.connected and \
       obs_host == _current_obs_host and \
       obs_port == _current_obs_port and \
       obs_password == _current_obs_password and \
       obs_enabled == _current_obs_enabled:
        return

    # Update cache
    _current_obs_host = obs_host
    _current_obs_port = obs_port
    _current_obs_password = obs_password
    _current_obs_enabled = obs_enabled

    # If disabled, disconnect and return
    if not obs_enabled:
        if obs:
            try:
                obs.disconnect()
            except:
                pass
            obs = None
        print("[Tracker OBS] OBS Bridge is disabled in config. Disconnected.")
        return

    def on_obs_connect():
        print("[Tracker OBS] Connection Established.")
        _cfg = _cached_tracker_config if _cached_tracker_config else load_config()
        send_to_ws({
            "type": "obs_info",
            "payload": {
                "scenes": [],
                "sources": _cfg.get("obs_sources", []),
                "connected": True
            }
        })
        # Sync tracking scenes
        try:
            def delayed_sync():
                global _current_obs_active_scene, _current_avatar_source, _current_secondary_sources
                time.sleep(1)
                if obs.connected:
                    print("[Tracker Automation] Triggering connection-synced tracking update...")
                    cfg = load_config()
                    cam_cfg = cfg.get("camera_tracking", {})
                    _current_obs_active_scene = cam_cfg.get("active_scene")
                    _current_avatar_source = cam_cfg.get("avatar_source")
                    _current_secondary_sources = sorted([s for s in cam_cfg.get("secondary_sources", []) if s])
                    obs_automation.sync_tracking_scenes(obs, cfg)
            threading.Thread(target=delayed_sync, daemon=True).start()
        except Exception as e:
            print(f"[Tracker Automation] Connection sync failed: {e}")

    def on_obs_error(msg):
        send_to_ws({"type": "obs_error", "message": msg})

    def on_obs_sources(sources):
        send_to_ws({"type": "obs_sources", "payload": sources})
        if obs.connected:
            for src in sources:
                obs.get_source_filter_list(src)

    def on_obs_scenes(scenes):
        _cfg = _cached_tracker_config if _cached_tracker_config else load_config()
        send_to_ws({"type": "obs_info", "payload": {
            "scenes": scenes,
            "sources": _cfg.get("obs_sources", []),
            "filters": _cfg.get("obs_filters", {}),
            "connected": True
        }})

    if obs:
        try:
            obs.disconnect()
        except:
            pass
            
    print(f"[Tracker OBS] Connecting to OBS at ws://{obs_host}:{obs_port}...")
    obs = OBSClient(
        host=obs_host,
        port=obs_port,
        password=obs_password,
        on_connect=on_obs_connect,
        on_error=on_obs_error,
        on_sources=on_obs_sources,
        on_scenes=on_obs_scenes
    )
    obs.connect()

    if not _obs_bridge_started:
        _obs_bridge_started = True
        threading.Thread(target=obs_bridge_loop, daemon=True, name="TrackerOBSBridgeLoop").start()

def obs_bridge_loop():
    global obs
    last_id_refresh = 0
    print("[Tracker OBS Bridge] Loop Started")
    
    while True:
        now = time.time()
        if obs and obs.connected and (now - last_id_refresh > 5):
            last_id_refresh = now
            pass
            
        if obs and obs.connected:
            _loop_cfg = _cached_tracker_config if _cached_tracker_config else load_config()
            for rid in list(obs._responses.keys()):
                resp = obs._responses.get(rid)
                if not resp:
                    continue
                if resp.get("requestType") == "GetSceneList":
                    scenes = [s["sceneName"] for s in resp.get("responseData", {}).get("scenes", [])]
                    send_to_ws({"type": "obs_info", "payload": {
                        "scenes": scenes,
                        "sources": _loop_cfg.get("obs_sources", []),
                        "filters": _loop_cfg.get("obs_filters", {}),
                        "connected": True
                    }})
                    obs._responses.pop(rid, None)
                elif resp.get("requestType") == "GetSourceFilterList":
                    filter_data = resp.get("responseData", {})
                    filters = [f["filterName"] for f in filter_data.get("filters", [])]
                    source_name = obs._filter_requests.pop(rid, "")
                    if source_name:
                        send_to_ws({"type": "obs_filters", "payload": {source_name: filters}})
                    obs._responses.pop(rid, None)
        time.sleep(0.1)

# Base path resolving helper
def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = get_base_dir()
CONFIG_FILE = os.path.join(BASE_DIR, "theater.json")

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Tracker] Error loading theater.json: {e}")
    return {}

# --- HTTP MJPEG Server for Camera Preview ---
class CamHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress HTTP logging
        pass

    def do_GET(self):
        global _camera_active, _current_frame
        if self.path.startswith('/cam.mjpg'):
            self.send_response(200)
            self.send_header('Content-type', 'multipart/x-mixed-replace; boundary=--jpgboundary')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            while _camera_active:
                frame = _current_frame
                if frame is not None:
                    try:
                        if cv2 is not None:
                            success, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
                            if success:
                                header = b'--jpgboundary\r\n'
                                header += b'Content-Type: image/jpeg\r\n'
                                header += f'Content-Length: {len(buffer)}\r\n\r\n'.encode()
                                self.wfile.write(header)
                                self.wfile.write(buffer.tobytes())
                                self.wfile.write(b'\r\n\r\n')
                    except Exception:
                        break
                time.sleep(1/30.0)
        elif self.path.startswith('/debug.mjpg'):
            self.send_response(200)
            self.send_header('Content-type', 'multipart/x-mixed-replace; boundary=jpgboundary')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            print(f"[Tracker MJPEG] Preview stream started for: {self.client_address}")
            while _camera_active:
                frame = _current_frame
                try:
                    if frame is not None:
                        draw_frame = VISION.get_debug_frame(frame)
                    else:
                        draw_frame = np.zeros((360, 640, 3), dtype=np.uint8)
                        draw_frame[:] = (40, 40, 40)
                        cv2.putText(draw_frame, "WAITING FOR CAMERA...", (150, 180), 
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
                    
                    if draw_frame is not None:
                        success, buffer = cv2.imencode('.jpg', draw_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
                        if success:
                            self.wfile.write(b"--jpgboundary\r\n")
                            self.wfile.write(b"Content-Type: image/jpeg\r\n")
                            self.wfile.write(f"Content-Length: {len(buffer)}\r\n\r\n".encode())
                            self.wfile.write(buffer.tobytes())
                            self.wfile.write(b"\r\n")
                            time.sleep(0.05)
                        else:
                            time.sleep(0.1)
                    else:
                        time.sleep(0.1)
                except Exception as e:
                    print(f"[Tracker MJPEG] Stream Loop Error: {e}")
                    break
            print(f"[Tracker MJPEG] Preview stream ended for: {self.client_address}")
        elif self.path.startswith('/mask.mjpg'):
            self.send_response(200)
            self.send_header('Content-type', 'multipart/x-mixed-replace; boundary=maskboundary')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            while _camera_active:
                try:
                    mask = VISION.last_mask
                    results = VISION.target_results
                    targets = VISION.targets
                    composite = np.zeros((360, 640, 3), dtype=np.uint8)
                    
                    if mask is not None and results and targets and cv2 is not None:
                        num_t = len(targets)
                        if num_t <= 1: gs = 1
                        elif num_t <= 4: gs = 2
                        elif num_t <= 9: gs = 3
                        else: gs = 4

                        mh, mw = mask.shape[:2]
                        cw, ch = mw // gs, mh // gs
                        
                        for i, tname in enumerate(targets):
                            if tname not in results: continue
                            col, row = i % gs, i // gs
                            sx, sy = col * cw, row * ch
                            cel_mask = mask[sy:sy+ch, sx:sx+cw]
                            full = cv2.resize(cel_mask, (640, 360), interpolation=cv2.INTER_NEAREST)
                            channel_idx = 2 - (i % 3)
                            composite[full > 0, channel_idx] = 255
                        
                    if cv2 is not None:
                        success, buffer = cv2.imencode('.png', composite)
                        if success:
                            self.wfile.write(b"--maskboundary\r\n")
                            self.wfile.write(b"Content-Type: image/png\r\n")
                            self.wfile.write(f"Content-Length: {len(buffer)}\r\n\r\n".encode())
                            self.wfile.write(buffer.tobytes())
                            self.wfile.write(b"\r\n")
                    time.sleep(0.05)
                except Exception:
                    break
        elif self.path.startswith('/snapshot'):
            self.send_response(200)
            self.send_header('Content-type', 'image/jpeg')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            frame = _current_frame
            if frame is not None and cv2 is not None:
                try:
                    success, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                    if success:
                        self.wfile.write(buffer.tobytes())
                except Exception as e:
                    print(f"[Tracker HTTP] Snapshot encoding failed: {e}")
            else:
                # Fallback to empty dark gray image
                if np is not None and cv2 is not None:
                    try:
                        placeholder = np.zeros((1080, 1920, 3), dtype=np.uint8)
                        placeholder[:] = (40, 40, 40)
                        success, buffer = cv2.imencode('.jpg', placeholder)
                        if success:
                            self.wfile.write(buffer.tobytes())
                    except Exception:
                        pass
        else:
            self.send_response(404)
            self.end_headers()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

_mjpeg_server = None

def start_mjpeg_server():
    global _mjpeg_server
    if _mjpeg_server is None:
        try:
            _mjpeg_server = ThreadedHTTPServer(('0.0.0.0', 41838), CamHandler)
            threading.Thread(target=_mjpeg_server.serve_forever, daemon=True, name="TrackerMJPEGServer").start()
            print("\n" + "!"*60)
            print("!!! TRACKER MJPEG SERVER IS LIVE ON PORT 41838 !!!")
            print("!!!" + "!"*57 + "\n")
        except Exception as e:
            print(f"[Tracker HTTP] Server failed to bind: {e}")

# --- Helper functions to find cameras ---
def _find_obs_camera_index():
    # 1. Check if user explicitly defined a camera index in config.json
    try:
        cfg = load_config()
        cam_cfg = cfg.get("camera_tracking", {})
        if "camera_index" in cam_cfg:
            return int(cam_cfg["camera_index"])
    except Exception:
        pass

    # Find by Exact Name using pygrabber
    try:
        from pygrabber.dshow_graph import FilterGraph
        graph = FilterGraph()
        devices = graph.get_input_devices()
        for idx, device_name in enumerate(devices):
            if "obs virtual camera" in device_name.lower():
                return idx
    except Exception:
        pass

    # Fallback Probe
    for i in range(10):
        try:
            cap = cv2.VideoCapture(i, cv2.CAP_DSHOW)
            if cap.isOpened():
                ret, frame = cap.read()
                if ret and frame is not None:
                    cap.release()
                    return i
                cap.release()
            
            cap = cv2.VideoCapture(i)
            if cap.isOpened():
                ret, frame = cap.read()
                if ret and frame is not None:
                    cap.release()
                    return i
                cap.release()
        except Exception:
            pass
    return 0

# --- Camera Capture & Vision Loop ---
def send_to_ws(msg):
    global _ws_client_conn, _ws_loop
    if _ws_client_conn and _ws_loop:
        try:
            asyncio.run_coroutine_threadsafe(_ws_client_conn.send(json.dumps(msg)), _ws_loop)
        except Exception as e:
            print(f"[Tracker WS] Send Error: {e}")

def cv2_camera_loop():
    global _camera_active, _camera_index, _current_frame, _last_targets_broadcast
    if not cv2:
        return
        
    start_mjpeg_server()    
    
    # Initialize Vision with current config
    try:
        cfg = load_config()
        VISION.config = cfg
        cam_cfg = cfg.get("camera_tracking", {})
        targets = []
        if cam_cfg.get("avatar_source"):
            targets.append(cam_cfg.get("avatar_source"))
        for s in cam_cfg.get("secondary_sources", []):
            if s and s not in targets:
                targets.append(s)
            
        VISION.update_settings(
            r=cam_cfg.get("chroma_r", 0),
            g=cam_cfg.get("chroma_g", 255),
            b=cam_cfg.get("chroma_b", 0),
            threshold=cam_cfg.get("threshold", 40),
            mode=cam_cfg.get("mode", "chroma"),
            precision=cam_cfg.get("precision", 5),
            fps_limit=cam_cfg.get("fps_limit", 30),
            targets=targets
        )
    except Exception as e:
        print(f"[Tracker Camera] Failed to init VISION from config: {e}")
    
    print(f"[Tracker Camera] Attempting to open index {_camera_index} using DSHOW backend...")
    cap = cv2.VideoCapture(int(_camera_index), cv2.CAP_DSHOW)
    if not cap.isOpened():
        print(f"[Tracker Camera] DSHOW backend failed. Trying DEFAULT backend...")
        cap = cv2.VideoCapture(int(_camera_index))
        
    if not cap.isOpened():
        print(f"[Tracker Camera] ERROR: Could not open camera index {_camera_index}.")
        _camera_active = False
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    print(f"[Tracker Camera] Stream ACTIVE on index {_camera_index}. Resolution: {cap.get(cv2.CAP_PROP_FRAME_WIDTH)}x{cap.get(cv2.CAP_PROP_FRAME_HEIGHT)}")

    consecutive_failures = 0
    try:
        while _camera_active:
            try:
                ret, frame = cap.read()
                if not ret or frame is None:
                    consecutive_failures += 1
                    if consecutive_failures > 30:
                        print("[Tracker Camera] Stream appears dead. Re-initializing...")
                        cap.release()
                        time.sleep(1.0)
                        cap = cv2.VideoCapture(int(_camera_index), cv2.CAP_DSHOW)
                        if not cap.isOpened():
                            cap = cv2.VideoCapture(int(_camera_index))
                        consecutive_failures = 0
                    time.sleep(0.1)
                    continue
                    
                consecutive_failures = 0
                _current_frame = frame
                
                # Process Vision coordinates
                VISION.process_frame(frame)

                # Broadcast targets to WebSocket server (relayed to overlay index.html)
                now_ts = time.time()
                fps_limit = getattr(VISION, 'fps_limit', 30)
                interval = 1.0 / max(1, fps_limit)
                
                if (now_ts - _last_targets_broadcast) >= interval:
                    _last_targets_broadcast = now_ts
                    results = VISION.target_results
                    
                    if results:
                        payload = {}
                        for tname, tdata in results.items():
                            payload[tname] = {
                                "x": tdata["x"],
                                "y": tdata["y"],
                                "mass": tdata.get("mass", 1),
                                "bounds": tdata["bounds"],
                                "polygon": [],
                                "pixel_grid": tdata.get("pixel_grid", []),
                                "use_box": False,
                                "use_polygon": False,
                                "use_pixel": True
                            }
                        send_to_ws({"type": "targets_update", "payload": payload})
                        
                        # Also send detailed coordinates and stats
                        send_to_ws({
                            "type": "tracking_stats",
                            "payload": {
                                "targets": len(results),
                                "names": list(results.keys()),
                                "status": "SYNCED"
                            }
                        })
                        
                        # Backward-compatible tracking_data broadcast
                        for name, data in results.items():
                            # Send mask only if pixel perfect mode is active and it's avatar
                            encoded_mask = None
                            if VISION.last_mask is not None and name == "Avatar":
                                _, buffer = cv2.imencode('.png', VISION.last_mask)
                                encoded_mask = base64.b64encode(buffer).decode('utf-8')

                            send_to_ws({
                                "type": "tracking_data", 
                                "target": name, 
                                "x": data["x"], 
                                "y": data["y"], 
                                "mass": data["mass"], 
                                "bounds": data["bounds"], 
                                "polygon": [], 
                                "use_box": False, 
                                "use_polygon": False, 
                                "use_pixel": True,
                                "mask": encoded_mask
                            })

            except Exception as e:
                print(f"[Tracker Camera] Loop warning: {e}")
                time.sleep(0.1)
                continue
    except BaseException as e:
        print(f"[Tracker Camera] Fatal camera error: {e}")
    finally:
        _camera_active = False
        try:
            cap.release()
        except:
            pass
        _current_frame = None
        print("[Tracker Camera] Stream stopped.")

def start_camera():
    global _camera_active, _camera_thread, _camera_index
    
    if _camera_active and _camera_thread and _camera_thread.is_alive():
        return
        
    _camera_active = True
    
    def camera_init_and_loop():
        global _camera_index
        obs_idx = _find_obs_camera_index()
        _camera_index = obs_idx if obs_idx != -1 else 0
        cv2_camera_loop()
        
    _camera_thread = threading.Thread(target=camera_init_and_loop, daemon=True)
    _camera_thread.start()
    print(f"[Tracker] Camera background thread spawned")

def stop_camera():
    global _camera_active
    _camera_active = False
    print("[Tracker] Camera stopped.")

# --- WebSocket Client Loop ---
async def websocket_client_loop():
    global _ws_client_conn, _camera_active
    
    # Resolve port dynamically
    port = 41839
    cfg = load_config()
    if "websocket_port" in cfg:
        port = int(cfg["websocket_port"])
        
    for arg in sys.argv:
        if arg.startswith("--ws-port="):
            try:
                port = int(arg.split("=")[1])
            except ValueError:
                pass
        elif arg.startswith("--port="):
            try:
                port = int(arg.split("=")[1])
            except ValueError:
                pass

    uri = f"ws://127.0.0.1:{port}"
    print(f"[Tracker WS] Connecting to WebSocket Server at {uri}...")
    
    while True:
        try:
            async with websockets.connect(uri, max_size=104857600) as websocket:
                _ws_client_conn = websocket
                print("[Tracker WS] Connected to Reader WebSocket server.")
                
                # Fetch initial config from Reader WebSocket
                await websocket.send(json.dumps({"type": "request_config_state"}))
                
                # Automatically start the camera if configured to do so
                start_camera()
                
                # Connect to OBS if configured
                connect_to_obs()

                async for message in websocket:
                    try:
                        data = json.loads(message)
                        m_type = data.get("type")
                        
                        if m_type == "config_updated" or m_type == "config_state":
                            payload = data.get("payload") or {}
                            # Update in-memory config cache from the received payload
                            # so downstream code doesn't need to read theater.json from disk
                            if payload:
                                _cached_tracker_config.update(payload)
                            obs_cfg = payload.get("obs_bridge", {})
                            # Only reconnect OBS if its own section changed
                            if obs_cfg and obs_cfg != {
                                "ip": _current_obs_host,
                                "port": _current_obs_port,
                                "obs_pass": _current_obs_password,
                                "enabled": _current_obs_enabled,
                            }:
                                connect_to_obs()
                                
                            if "camera_tracking" in payload:
                                cam_cfg = payload["camera_tracking"]
                                print(f"[Tracker WS] Received Config Update. Refreshing settings...")
                                targets = []
                                if cam_cfg.get("avatar_source"):
                                    targets.append(cam_cfg.get("avatar_source"))
                                for s in cam_cfg.get("secondary_sources", []):
                                    if s and s not in targets:
                                        targets.append(s)
                                        
                                VISION.update_settings(
                                    r=cam_cfg.get("chroma_r", 0),
                                    g=cam_cfg.get("chroma_g", 255),
                                    b=cam_cfg.get("chroma_b", 0),
                                    threshold=cam_cfg.get("threshold", 40),
                                    mode=cam_cfg.get("mode", "chroma"),
                                    precision=cam_cfg.get("precision", 5),
                                    fps_limit=cam_cfg.get("fps_limit", 30),
                                    targets=targets
                                )
                                if obs and obs.connected:
                                    global _current_obs_active_scene, _current_avatar_source, _current_secondary_sources
                                    new_active_scene = cam_cfg.get("active_scene")
                                    new_avatar_source = cam_cfg.get("avatar_source")
                                    new_secondaries = cam_cfg.get("secondary_sources", [])
                                    new_secondaries_clean = sorted([s for s in new_secondaries if s])
                                    
                                    if new_active_scene != _current_obs_active_scene or \
                                       new_avatar_source != _current_avatar_source or \
                                       new_secondaries_clean != _current_secondary_sources:
                                        
                                        _current_obs_active_scene = new_active_scene
                                        _current_avatar_source = new_avatar_source
                                        _current_secondary_sources = new_secondaries_clean
                                        
                                        print(f"[Tracker Automation] Active scene or tracking sources changed. Syncing tracking scenes in OBS...")
                                        try:
                                            threading.Thread(target=lambda: obs_automation.sync_tracking_scenes(obs, load_config()), daemon=True).start()
                                        except Exception as e:
                                            print(f"[Tracker Automation] Scene sync failed: {e}")
                                    else:
                                        print(f"[Tracker Automation] Active scene and tracking sources unchanged. Skipping OBS scene sync.")
                                
                        elif m_type == "run_obs_setup":
                            print("[Tracker OBS] Running manual OBS setup...")
                            if obs and obs.connected:
                                def _do_setup():
                                    global _current_obs_active_scene, _current_avatar_source, _current_secondary_sources
                                    sources = obs_automation.setup_theatre_obs(obs)
                                    if sources:
                                        send_to_ws({"type": "obs_sources", "payload": sources})
                                    
                                    cfg = load_config()
                                    cam_cfg = cfg.get("camera_tracking", {})
                                    _current_obs_active_scene = cam_cfg.get("active_scene")
                                    _current_avatar_source = cam_cfg.get("avatar_source")
                                    _current_secondary_sources = sorted([s for s in cam_cfg.get("secondary_sources", []) if s])
                                    
                                    obs_automation.sync_tracking_scenes(obs, cfg)
                                threading.Thread(target=_do_setup, daemon=True).start()
                            else:
                                print("[Tracker OBS] Cannot run setup: OBS not connected.")
                                
                        elif m_type == "refresh_obs_sources":
                            if obs and obs.connected:
                                obs.call("GetInputList")
                                
                        elif m_type == "fetch_obs_info":
                            if obs and obs.connected:
                                obs.get_scene_list()
                                obs.call("GetInputList")
                                for src in load_config().get("obs_sources", []):
                                    obs.get_source_filter_list(src)
                            else:
                                send_to_ws({
                                    "type": "obs_info",
                                    "payload": {
                                        "scenes": [],
                                        "sources": [],
                                        "filters": {},
                                        "connected": False
                                    }
                                })
                                
                        elif m_type == "execute_actions":
                            actions = data.get("payload")
                            mock_data = data.get("data", {})
                            execute_actions(actions, obs, data=mock_data)
                                
                        elif m_type == "vision_preview_update":
                            p = data.get("payload", {})
                            print(f"[Tracker WS] Preview update: color=({p.get('chroma_r')},{p.get('chroma_g')},{p.get('chroma_b')}), thresh={p.get('mask_threshold')}")
                            
                            VISION.update_settings(
                                r=p.get("chroma_r", 0),
                                g=p.get("chroma_g", 255),
                                b=p.get("chroma_b", 0),
                                threshold=int(p.get("mask_threshold", 128)),
                                mode=p.get("mode", "chroma"),
                                precision=int(p.get("precision", 5))
                            )
                            
                        elif m_type == "start_camera":
                            start_camera()
                            
                        elif m_type == "stop_camera":
                            stop_camera()
                            
                        elif m_type == "update_resolution":
                            w = data.get("width", 1920)
                            h = data.get("height", 1080)
                            VISION.set_canvas_resolution(w, h)
                            
                    except Exception as ex:
                        print(f"[Tracker WS] Message handling error: {ex}")
                        
        except Exception as e:
            _ws_client_conn = None
            print(f"[Tracker WS] Connection lost: {e}. Retrying in 3 seconds...")
            await asyncio.sleep(3)

def main():
    global _ws_loop
    print("=== Theater Scene Camera Tracker ===")
    if not HAS_OPENCV:
        print("[Tracker] Error: OpenCV or NumPy is not installed. Camera tracking is disabled.")
        sys.exit(1)
        
    _ws_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_ws_loop)
    try:
        _ws_loop.run_until_complete(websocket_client_loop())
    except KeyboardInterrupt:
        print("[Tracker] Shutting down...")
        stop_camera()

if __name__ == "__main__":
    main()
