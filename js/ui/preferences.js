/**
 * ARCHITECTURAL NOTE: Theatre Overlay
 *
 * 1. Environment Constraints (OBS Browser Docks/Sources)
 *    - The "Dropdown" Rule: Standard HTML <select> dropdown menus do not function correctly
 *      inside OBS interactive browser sources/docks.
 *    - Standardized UI Pattern: All multiple-choice selections in the UI (e.g., Action,
 *      Collision type) MUST use the custom `.pill-group` and
 *      `.pill-btn` layout instead of <select>.
 *    - Payload Extraction: UI state is extracted by querying the active class:
 *      `win.querySelector('.pill-group-name .pill-btn.active').getAttribute('data-value')`.
 *
 * 2. Data Persistence & Architecture
 *    - Configuration Manager: Handles the frontend configuration panel. It generates dynamic
 *      HTML templates for different object types (image for throwables, audio for sound elements).
 *    - Storage: All user settings are serialized as JSON and saved directly to the browser's
 *      localStorage under the key 'theatre_config'.
 *
 * 3. State Execution & Rendering (app.js & Entity Classes)
 *    - The Canvas Loop: app.js manages a persistent RequestAnimationFrame loop on an HTML5 canvas.
 *    - Instantiation: spawnItem(config) parses the payload and instantiates the correct entity class.
 *    - DOM Manipulation: Collisions or triggered timers execute events (formerly reacting on the DOM).
 *
 * 4. External Bridging (websocket.js)
 *    - Trigger Relay: The overlay maintains a WebSocket connection to an external backend.
 *    - Decoupling: The backend simply passes JSON payloads. The frontend handles all translation
 *      of these triggers into visual canvas events.
 */

// --- Preferences Manager ---
class PreferencesManager {
    constructor() {
        this.maxEntities = 100; // Limit total items on screen
        this.itemDuration = 3000; // How long items stay on screen after landing/sticking
        this.stickyTracking = true; // Follow the target move when sticking
        this.smoothingEnabled = true; // Smooth interpolation for tracking

        // Load settings immediately so they are available to Alpine.js before DOMContentLoaded
        this.loadSettings();

        // Wait for DOM to attach events
        document.addEventListener('DOMContentLoaded', () => {
            this.setupEventListeners();
            // Re-run in case DOM elements need updating
            this.loadSettings();
        });
    }
    setupEventListeners() {
        const stickyToggle = document.getElementById('pref-sticky-tracking');
        if (stickyToggle) {
            stickyToggle.addEventListener('change', (e) => {
                this.stickyTracking = e.target.checked;
                this.saveSettings();
            });
        }

        const smoothingToggle = document.getElementById('pref-smoothing-enabled');
        if (smoothingToggle) {
            smoothingToggle.addEventListener('change', (e) => {
                this.smoothingEnabled = e.target.checked;
                this.saveSettings();
            });
        }

        const maxEntitiesInput = document.getElementById('pref-max-entities');
        if (maxEntitiesInput) {
            maxEntitiesInput.addEventListener('change', (e) => {
                const parsed = parseInt(e.target.value);
                if (!isNaN(parsed) && parsed > 0) {
                    this.maxEntities = parsed;
                    this.saveSettings();
                }
            });
        }

        const itemDurationInput = document.getElementById('pref-item-duration');
        if (itemDurationInput) {
            itemDurationInput.addEventListener('change', (e) => {
                const parsed = parseInt(e.target.value);
                if (!isNaN(parsed) && parsed >= 0) {
                    this.itemDuration = parsed;
                    this.saveSettings();
                }
            });
        }
    }

    saveSettings() {
        try {
            localStorage.setItem('theatre_preferences', JSON.stringify({
                maxEntities: this.maxEntities,
                itemDuration: this.itemDuration,
                stickyTracking: this.stickyTracking,
                smoothingEnabled: this.smoothingEnabled
            }));
        } catch (e) {
            console.warn("Unable to save settings to localStorage:", e);
        }
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('theatre_preferences');
            if (saved) {
                const config = JSON.parse(saved);
                this.stickyTracking = config.stickyTracking !== undefined ? config.stickyTracking : true;
                const stickyToggle = document.getElementById('pref-sticky-tracking');
                if (stickyToggle) stickyToggle.checked = this.stickyTracking;

                this.smoothingEnabled = config.smoothingEnabled !== undefined ? config.smoothingEnabled : true;
                const smoothingToggle = document.getElementById('pref-smoothing-enabled');
                if (smoothingToggle) smoothingToggle.checked = this.smoothingEnabled;

                this.maxEntities = config.maxEntities !== undefined ? config.maxEntities : 100;
                const maxEntitiesInput = document.getElementById('pref-max-entities');
                if (maxEntitiesInput) maxEntitiesInput.value = this.maxEntities;

                this.itemDuration = config.itemDuration !== undefined ? config.itemDuration : 3000;
                const itemDurationInput = document.getElementById('pref-item-duration');
                if (itemDurationInput) itemDurationInput.value = this.itemDuration;
            }
        } catch (e) {
            console.error("Error loading preferences:", e);
        }
    }
}
