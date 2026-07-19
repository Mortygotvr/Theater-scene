import asyncio
import json
import base64
import hashlib
import websockets
import threading
import time
import random
try:
    from config import STOP_EVENT
except ImportError:
    STOP_EVENT = threading.Event()

class OBSClient:
    def __init__(self, host="localhost", port=4455, password="", on_connect=None, on_error=None, on_sources=None, on_scenes=None, **kwargs):
        self.uri = f"ws://{host}:{port}"
        self.password = password
        self.on_connect = on_connect
        self.on_error = on_error
        self.on_sources = on_sources
        self.on_scenes = on_scenes
        self._loop = None
        self._thread = None
        self.connected = False
        self.running = True
        self._request_id = 0
        self._responses = {}
        self._callbacks = {}
        self._futures = {}
        self._filter_requests = {}  # rid -> source_name for GetSourceFilterList calls

    def connect(self):
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _run_loop(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._main())

    async def _main(self):
        while self.running:
            try:
                async with websockets.connect(self.uri) as ws:
                    if not self.running:
                        await ws.close()
                        break
                    self.ws = ws
                    print(f"[OBS] Connected to {self.uri}")
                    
                    # 1. Identify
                    hello = json.loads(await ws.recv())
                    auth_needed = "authentication" in hello.get("d", {})
                    
                    identify_payload = {
                        "op": 1,
                        "d": {
                            "rpcVersion": 1,
                        }
                    }
                    
                    if auth_needed:
                        if self.password:
                            auth_data = hello["d"]["authentication"]
                            challenge = auth_data["challenge"]
                            salt = auth_data["salt"]
                            
                            # Authentication logic
                            secret = base64.b64encode(hashlib.sha256((self.password + salt).encode()).digest()).decode()
                            auth_response = base64.b64encode(hashlib.sha256((secret + challenge).encode()).digest()).decode()
                            identify_payload["d"]["authentication"] = auth_response
                        else:
                            print("[OBS] Error: Authentication required by OBS but no password provided in config!")
                            self.connected = False
                            await asyncio.sleep(10)
                            continue
                    
                    # 2. Send Identify
                    await ws.send(json.dumps(identify_payload))
                    print("[OBS] Identify payload sent. Waiting for confirmation...")
                    
                    async for message in ws:
                        if not self.running:
                            break
                        data = json.loads(message)
                        op = data.get("op")
                        
                        if op == 2: # Identified
                            print("[OBS] Identified successfully.")
                            self.connected = True
                            if self.running and self.on_connect:
                                self.on_connect()
                            
                            # 3. Initial Data Fetch (Now that we are identified)
                            await ws.send(json.dumps({
                                "op": 6,
                                "d": {
                                    "requestType": "GetInputList",
                                    "requestId": "initial_sources_fetch"
                                }
                            }))
                            await ws.send(json.dumps({
                                "op": 6,
                                "d": {
                                    "requestType": "GetSceneList",
                                    "requestId": "initial_scenes_fetch"
                                }
                            }))
                        
                        elif op == 7: # RequestResponse
                            d = data.get("d", {})
                            rid = d.get("requestId")
                            if rid in self._callbacks:
                                self._callbacks[rid](d)
                                del self._callbacks[rid]
                            if rid in self._futures:
                                self._loop.call_soon_threadsafe(self._futures[rid].set_result, d)
                                del self._futures[rid]
                            self._responses[rid] = d
                            
                            # Special handling for initial fetch
                            if rid == "initial_sources_fetch":
                                sources = [inp["inputName"] for inp in data["d"]["responseData"]["inputs"]]
                                if self.on_sources:
                                    self.on_sources(sources)
                            elif rid == "initial_scenes_fetch":
                                scenes = [s["sceneName"] for s in data["d"]["responseData"]["scenes"]]
                                if hasattr(self, 'on_scenes') and self.on_scenes:
                                    self.on_scenes(scenes)
                
            except Exception as e:
                self.connected = False
                if not self.running:
                    break
                if self.on_error:
                    self.on_error(str(e))
                if not STOP_EVENT.is_set():
                    print(f"[OBS] Connection error: {e}. Retrying in 5s...")
                await asyncio.sleep(5)

    def disconnect(self):
        self.running = False
        if hasattr(self, 'ws') and self.ws:
            try:
                asyncio.run_coroutine_threadsafe(self.ws.close(), self._loop)
            except:
                pass

    def call_sync(self, request_type, request_data=None, timeout=5.0):
        if not self.connected or not self.ws:
            return None
            
        self._request_id += 1
        rid = str(self._request_id)
        
        event = threading.Event()
        result = {"data": None}
        
        def callback(data):
            result["data"] = data
            event.set()
            
        self._callbacks[rid] = callback
        
        payload = {
            "op": 6,
            "d": {
                "requestType": request_type,
                "requestId": rid,
                "requestData": request_data or {}
            }
        }
        
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(payload)), self._loop)
        
        if event.wait(timeout):
            return result["data"]
        return None

    def call(self, request_type, request_data=None):
        if not self.connected or not self.ws:
            return None
            
        self._request_id += 1
        rid = str(self._request_id)
        
        payload = {
            "op": 6,
            "d": {
                "requestType": request_type,
                "requestId": rid,
                "requestData": request_data or {}
            }
        }
        
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(payload)), self._loop)
        return rid

    def set_source_transform(self, scene_name, scene_item_id, x, y):
        self.call("SetSceneItemTransform", {
            "sceneName": scene_name,
            "sceneItemId": scene_item_id,
            "sceneItemTransform": {
                "positionX": x,
                "positionY": y
            }
        })

    def set_scene_item_transform(self, scene_name, scene_item_id, transform):
        return self.call("SetSceneItemTransform", {
            "sceneName": scene_name,
            "sceneItemId": scene_item_id,
            "sceneItemTransform": transform
        })

    def get_scene_item_list(self, scene_name):
        return self.call("GetSceneItemList", {"sceneName": scene_name})

    def create_scene(self, scene_name):
        return self.call_sync("CreateScene", {"sceneName": scene_name})

    def create_input(self, scene_name, input_name, input_kind, input_settings=None, scene_item_enabled=True):
        return self.call("CreateInput", {
            "sceneName": scene_name,
            "inputName": input_name,
            "inputKind": input_kind,
            "inputSettings": input_settings or {},
            "sceneItemEnabled": scene_item_enabled
        })

    def set_scene_item_enabled(self, scene_name, scene_item_id, enabled):
        return self.call("SetSceneItemEnabled", {
            "sceneName": scene_name,
            "sceneItemId": scene_item_id,
            "sceneItemEnabled": enabled
        })
    def create_scene_item(self, scene_name, source_name, enabled=True):
        return self.call("CreateSceneItem", {
            "sceneName": scene_name,
            "sourceName": source_name,
            "sceneItemEnabled": enabled
        })

    def create_scene_item_sync(self, scene_name, source_name, enabled=True):
        resp = self.call_sync("CreateSceneItem", {
            "sceneName": scene_name,
            "sourceName": source_name,
            "sceneItemEnabled": enabled
        })
        if resp and "responseData" in resp:
            return resp["responseData"].get("sceneItemId")
        return None

    def get_input_list(self, input_kind=None):
        return self.call("GetInputList", {"inputKind": input_kind} if input_kind else {})

    def get_scene_list(self):
        return self.call("GetSceneList")

    def get_source_filter_list(self, source_name):
        rid = self.call("GetSourceFilterList", {"sourceName": source_name})
        if rid:
            self._filter_requests[rid] = source_name
        return rid

    def set_filter_setting(self, source_name, filter_name, key, value):
        """Set a single key within a source filter's settings (merges with existing)."""
        return self.call("SetSourceFilterSettings", {
            "sourceName": source_name,
            "filterName": filter_name,
            "filterSettings": {key: value},
            "overlay": True
        })

    def toggle_source_visibility(self, scene_name, source_name):
        resp = self.call_sync("GetSceneItemList", {"sceneName": scene_name})
        if resp and "responseData" in resp and "sceneItems" in resp["responseData"]:
            for item in resp["responseData"]["sceneItems"]:
                if item["sourceName"] == source_name:
                    new_state = not item.get("sceneItemEnabled", True)
                    self.set_scene_item_enabled(scene_name, item["sceneItemId"], new_state)
                    return True
        return False

    def toggle_filter(self, source_name, filter_name):
        resp = self.call_sync("GetSourceFilter", {"sourceName": source_name, "filterName": filter_name})
        if resp and "responseData" in resp:
            new_state = not resp["responseData"].get("filterEnabled", True)
            self.call("SetSourceFilterEnabled", {
                "sourceName": source_name,
                "filterName": filter_name,
                "filterEnabled": new_state
            })
            return True
        return False

    def remove_scene(self, scene_name):
        return self.call_sync("RemoveScene", {"sceneName": scene_name})

    def get_source_snapshot(self, source_name):
        """Gets a screenshot of a source and returns it as an OpenCV image (numpy array)."""
        resp = self.call_sync("GetSourceScreenshot", {
            "sourceName": source_name,
            "imageFormat": "png"
        })
        
        if not resp or "responseData" not in resp:
            return None
            
        img_data = resp["responseData"].get("imageData")
        if not img_data:
            return None
            
        try:
            # imageData is a data URI: data:image/png;base64,xxxx
            if "," in img_data:
                img_data = img_data.split(",")[1]
            
            import cv2
            import numpy as np
            
            binary_data = base64.b64decode(img_data)
            nparr = np.frombuffer(binary_data, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            return img
        except Exception as e:
            print(f"[OBS] Snapshot error: {e}")
            return None

    def start_virtual_cam(self):
        return self.call("StartVirtualCam")

    def stop_virtual_cam(self):
        return self.call("StopVirtualCam")
