import os
import sys
import subprocess
import threading
import time
import webbrowser

def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = get_base_dir()
PYTHON_EXE = sys.executable

processes = []
stop_event = threading.Event()

def run_process_and_keep_alive(cmd, name):
    def run():
        while not stop_event.is_set():
            print(f"[Main] Launching {name}: {' '.join(cmd)}")
            try:
                p = subprocess.Popen(cmd, cwd=BASE_DIR)
                processes.append(p)
                while not stop_event.is_set():
                    ret = p.poll()
                    if ret is not None:
                        print(f"[Main] Process {name} exited with code {ret}")
                        break
                    time.sleep(1)
                try:
                    processes.remove(p)
                except ValueError:
                    pass
            except Exception as e:
                print(f"[Main] Error running {name}: {e}")
            if not stop_event.is_set():
                time.sleep(2)
    t = threading.Thread(target=run, daemon=True, name=f"KeepAlive_{name}")
    t.start()

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Theater Scene Main Launcher")
    parser.add_argument("--port", type=int, default=41839, help="WebSocket port for Theater Scene")
    parser.add_argument("--ws-port", type=int, default=None, help="WebSocket port (alias for --port)")
    parser.add_argument("--reader-port", type=int, default=41837, help="WebSocket port of Theater Reader")
    parser.add_argument("--no-overlay", action="store_true", help="Do not open Overlay on launch")
    args = parser.parse_args()

    scene_port = args.ws_port if args.ws_port is not None else args.port
    reader_port = args.reader_port

    print("=== Theater Scene Master Orchestrator ===")
    print(f"[Main] Scene WS Port: {scene_port}")
    print(f"[Main] Reader WS Port: {reader_port}")

    # 1. Start WebSocket Server subprocess
    ws_cmd = [PYTHON_EXE, "websocket_server.py", f"--port={scene_port}"]
    run_process_and_keep_alive(ws_cmd, "WS_Server")

    # Cooldown delay for WS server setup
    time.sleep(1.5)

    # 2. Start Camera Scene Tracker subprocess
    tracker_cmd = [PYTHON_EXE, "scene_tracker.py", f"--port={scene_port}"]
    run_process_and_keep_alive(tracker_cmd, "Scene_Tracker")

    # 3. Start local HTTP Server to serve overlay and config pages
    http_cmd = [PYTHON_EXE, "-m", "http.server", "41836", "--bind", "0.0.0.0"]
    run_process_and_keep_alive(http_cmd, "HTTP_Server")

    # Write ports to js/launch-ports.js so index.html can read them without query params
    launch_ports_path = os.path.join(BASE_DIR, "js", "launch-ports.js")
    try:
        os.makedirs(os.path.dirname(launch_ports_path), exist_ok=True)
        with open(launch_ports_path, "w", encoding="utf-8") as f:
            f.write(f"window.LAUNCH_PORTS = {{\n  readerPort: {reader_port},\n  scenePort: {scene_port}\n}};\n")
        print(f"[Main] Successfully wrote launch-ports.js with readerPort={reader_port}, scenePort={scene_port}")
    except Exception as e:
        print(f"[Main] Error writing launch-ports.js: {e}")

    # Resolve HTTP server URLs (bypasses browser PNA restrictions and serves index.html at root)
    viewer_url = "http://localhost:41836/"
    settings_url = "http://localhost:41836/config.html"

    def open_overlay():
        print(f"[Main] Opening Overlay in web browser: {viewer_url}")
        webbrowser.open(viewer_url)

    def open_settings():
        print(f"[Main] Opening Settings in web browser: {settings_url}")
        webbrowser.open(settings_url)


    # 4. Cleanup helper
    def cleanup():
        stop_event.set()
        print("[Main] Terminating all background subprocesses...")
        for p in list(processes):
            try:
                p.terminate()
                p.wait(timeout=2)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        print("[Main] Subprocesses terminated successfully.")

    # 5. Tray Icon construction
    try:
        import pystray
        from PIL import Image, ImageDraw
        HAS_TRAY = True
    except ImportError:
        HAS_TRAY = False

    if HAS_TRAY:
        def create_image():
            w, h = 64, 64
            image = Image.new('RGB', (w, h), color=(20, 20, 20))
            d = ImageDraw.Draw(image)
            # Draw green tracking rectangle and crosshair icon
            d.rectangle([(16,16), (48,48)], outline=(0, 255, 204), width=3)
            d.line([(32, 8), (32, 56)], fill=(0, 255, 204), width=2)
            d.line([(8, 32), (56, 32)], fill=(0, 255, 204), width=2)
            return image

        def on_exit(icon, item):
            cleanup()
            icon.stop()
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("Open Settings (Config)", lambda icon, item: open_settings()),
            pystray.MenuItem("Open Overlay (Theater)", lambda icon, item: open_overlay()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Exit", on_exit)
        )

        # Monkey-patch pystray for Windows double/left-click behavior
        if hasattr(pystray, '_win32'):
            original_on_notify = pystray._win32.Icon._on_notify
            def custom_on_notify(self, wparam, lparam):
                win32_mod = pystray._win32.win32
                if lparam == win32_mod.WM_LBUTTONUP:
                    lparam = win32_mod.WM_RBUTTONUP
                original_on_notify(self, wparam, lparam)
            pystray._win32.Icon._on_notify = custom_on_notify

        icon = pystray.Icon("TheaterScene", create_image(), "Theater Scene Tracker", menu)
        print("[Main] Starting system tray icon...")
        icon.run()
    else:
        print("[Main] Pystray/PIL not available or disabled. Running in CLI mode.")
        print("[Main] Press Ctrl+C to terminate.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            cleanup()

if __name__ == "__main__":
    # Prevent PyInstaller fork bomb / route sub-processes when frozen
    if len(sys.argv) > 1:
        if sys.argv[1] == "websocket_server.py":
            sys.argv.pop(1)
            import websocket_server
            websocket_server.main()
            sys.exit(0)
        elif sys.argv[1] == "scene_tracker.py":
            sys.argv.pop(1)
            import scene_tracker
            scene_tracker.main()
            sys.exit(0)
        elif sys.argv[1] == "-m" and len(sys.argv) > 2 and sys.argv[2] == "http.server":
            # Replicate python -m http.server inside the frozen executable
            import http.server
            port = 8000
            bind = '0.0.0.0'
            if len(sys.argv) > 3:
                try:
                    port = int(sys.argv[3])
                except ValueError:
                    pass
            for i, arg in enumerate(sys.argv):
                if arg == "--bind" and i + 1 < len(sys.argv):
                    bind = sys.argv[i + 1]
            
            print(f"[Main HTTP] Starting http.server on {bind}:{port}...")
            from http.server import SimpleHTTPRequestHandler
            os.chdir(get_base_dir())
            http.server.test(HandlerClass=SimpleHTTPRequestHandler, port=port, bind=bind)
            sys.exit(0)

    main()
