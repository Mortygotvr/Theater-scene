# 🎬 Theater Scene

**Theater Scene** is an interactive, 3D WebGL overlay and OBS scene tracking engine designed for live streamers. It brings dynamic physics, custom throwables, hitboxes, and particle effects (fire, water, lightning) directly to your live stream overlay.

---

## 📌 Prerequisites

> [!IMPORTANT]
> **Theater Scene requires [Theater Reader](https://github.com/Mortygotvr/Theater-reader) to function.**
> Theater Reader acts as the central chat aggregator, TTS trigger, and WebSocket event broadcaster for stream interactions.

---

## 🚀 Features

- 🎮 **Interactive 3D WebGL Physics Engine**: Built with Three.js for interactive throwables, ragdoll/static entities, and particle streams.
- 📹 **Real-Time OBS Scene Tracking**: Tracks OBS scenes and sources automatically via OBS WebSocket integration.
- 🎨 **Visual Scene Editor**: Built-in web editor (`config.html`) to customize objects, hitboxes, spawn points, and event triggers.
- ⚡ **WebSocket Server**: Seamless real-time event communication between Theater Reader, Control Panel, and OBS.

---

## 🎥 OBS Setup Guide

To integrate Theater Scene into OBS Studio, follow these steps:

### Step 1: Add `index.html` as a Browser Source
1. Open OBS Studio.
2. In your target Scene, add a new **Browser Source** under **Sources**.
3. Check **Local file** and browse to select [index.html](file:///c:/Users/death/repo/Theater-scene/index.html) from your Theater Scene folder.
4. Set the **Width** and **Height** to match your canvas size (e.g., `1920` x `1080`).
5. Enable **Control audio via OBS** (if using audio collision triggers).

### Step 2: Configure OBS Virtual Camera / Master Source
1. In OBS, set **`$theater_master`** as your **Virtual Camera** (or main scene capture source).
2. This allows Theater Scene's tracking engine to track your avatar, hitboxes, and camera positions in real time.

---

## ⚙️ Configuration & Customization

1. Run `TheaterScene.exe` (or `python main.py`) to launch the WebSocket server and OBS client automation.
2. Open [config.html](file:///c:/Users/death/repo/Theater-scene/config.html) in your web browser to open the visual scene editor.
3. Configure your objects, hitboxes, physics properties, and collision sounds.

---

## 🔒 License

Licensed under the **MIT License (with Non-Commercial / No-Resale Restriction)**. See [LICENSE](https://github.com/Mortygotvr/Theater-scene/blob/main/LICENSE) for details.
