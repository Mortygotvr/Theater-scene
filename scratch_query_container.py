import os
import sys
import json
import time

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from obs_client import OBSClient

def main():
    try:
        with open("theater.json", "r", encoding="utf-8") as f:
            config = json.load(f)
        obs_cfg = config.get("obs_bridge", {})
        ip = obs_cfg.get("ip", "127.0.0.1")
        port = int(obs_cfg.get("port", 4455))
        password = obs_cfg.get("password", "") or obs_cfg.get("obs_pass", "")
    except Exception as e:
        print(f"Error reading config: {e}")
        return

    client = OBSClient(host=ip, port=port, password=password)
    client.connect()
    
    for _ in range(30):
        if client.connected:
            break
        time.sleep(0.1)
        
    if not client.connected:
        print("Failed to connect to OBS.")
        return
        
    print("Querying scene item transform of '$Chat' inside '$theater_master'...")
    resp = client.call_sync("GetSceneItemList", {"sceneName": "$theater_master"})
    if resp and "responseData" in resp:
        items = resp["responseData"].get("sceneItems", [])
        for si in items:
            source_name = si.get("sourceName")
            print(f"Item in $theater_master: {source_name}")
            if source_name == "$Chat":
                t_resp = client.call_sync("GetSceneItemTransform", {
                    "sceneName": "$theater_master",
                    "sceneItemId": si.get("sceneItemId")
                })
                if t_resp and "responseData" in t_resp:
                    print(json.dumps(t_resp["responseData"], indent=2))
                else:
                    print(f"Failed: {t_resp}")
    else:
        print(f"Failed to get items: {resp}")
        
    client.running = False
    time.sleep(0.5)

if __name__ == "__main__":
    main()
