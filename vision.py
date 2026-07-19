try:
    import cv2
    import numpy as np
    HAS_OPENCV = True
    print(f"[VISION] OpenCV loaded from: {cv2.__file__}")
    print(f"[VISION] Numpy loaded from: {np.__file__}")
except ImportError:
    HAS_OPENCV = False
    print("[VISION] OpenCV/Numpy NOT FOUND - Vision features disabled.")
    
import time

class VisionEngine:
    """
    ===========================================================================
    ⚠️ CRITICAL: TRACKING LOGIC IS LOCKED - DO NOT MODIFY ⚠️
    ===========================================================================
    THE SLICING, STACKING, AND COORDINATE MAPPING LOGIC (4th REVISION) 
    IS FINALIZED AND MUST NOT BE CHANGED UNDER ANY CIRCUMSTANCES UNLESS 
    THE USER EXPLICITLY REQUESTS A CHANGE TO THE VISION ENGINE.
    
    FORBIDDEN ACTIONS:
    - Altering Grid Slicing (Square Grid 1x1, 2x2, 3x3, 4x4)
    - Changing Canvas-to-Cel Scaling (Superposition/Stacking)
    - Modifying Aspect Ratio (Locked to 16:9)
    - Re-optimizing 'Pixel Scan' math
    ===========================================================================
    """
    def __init__(self):
        self.targets = []
        self.target_results = {}
        self.target_rgb = (0, 255, 0)
        self.threshold = 40
        self.detection_mode = "chroma"
        self.precision = 5
        self.canvas_width = 1920
        self.canvas_height = 1080
        self.target_rects = {} # {target_name: [x, y, w, h]}
        self.config = {}      # Root configuration for priority tracking
        if HAS_OPENCV:
            self.lower_hsv = np.array([0, 0, 0])
            self.upper_hsv = np.array([255, 255, 255])
            self._update_hsv_bounds()
        else:
            self.lower_hsv = None
            self.upper_hsv = None
        self.last_mask = None
        self._frame_count = 0
        self.fps_limit = 30

    def update_settings(self, **kwargs):
        """Update the vision tracking settings from the application configuration."""
        self.config.update(kwargs)
        
        # Extract core settings with legacy and variant key support
        r = kwargs.get('chroma_r', kwargs.get('r', 0))
        g = kwargs.get('chroma_g', kwargs.get('g', 255))
        b = kwargs.get('chroma_b', kwargs.get('b', 0))
        
        self.target_rgb = (r, g, b)
        self.threshold = kwargs.get('threshold', 128)
        self.detection_mode = kwargs.get('mode', 'chroma')
        self.precision = kwargs.get('precision', 5)
        self.fps_limit = kwargs.get('fps_limit', 30)

        if 'targets' in kwargs:
            self.targets = kwargs['targets']
        elif 'secondary_sources' in kwargs:
            self.targets = kwargs['secondary_sources']

        self._update_hsv_bounds()
        print(f"[VISION] Settings Updated: Color={self.target_rgb}, Threshold={self.threshold}, Targets={self.targets}, FPS Limit={self.fps_limit}")

    def _update_hsv_bounds(self):
        """Convert the target RGB to HSV and set the min/max bounds based on threshold."""
        if not HAS_OPENCV: return
        rgb_pixel = np.uint8([[ [self.target_rgb[2], self.target_rgb[1], self.target_rgb[0]] ]]) # BGR
        hsv_pixel = cv2.cvtColor(rgb_pixel, cv2.COLOR_BGR2HSV)[0][0]
        h, s, v = int(hsv_pixel[0]), int(hsv_pixel[1]), int(hsv_pixel[2])
        h_thresh = self.threshold // 2
        self.lower_hsv = np.array([max(0, h - h_thresh), 50, 50])
        self.upper_hsv = np.array([min(179, h + h_thresh), 255, 255])

    def process_frame(self, frame):
        self._frame_count += 1
        """
        Process the frame by 'Slicing' it into target areas.
        Supports 'Overlapping' slices by allowing rects to occupy the same space.
        """
        if not HAS_OPENCV or frame is None: return {}
        orig_h, orig_w = frame.shape[:2]
        
        # 1. Performance: Create a standard 640p processing frame
        proc_w = 640
        proc_h = int(orig_h * (proc_w / orig_w)) if orig_w > 0 else 360
        proc_frame = cv2.resize(frame, (proc_w, proc_h), interpolation=cv2.INTER_NEAREST)
        
        # 2. Create the Full Mask once (fastest way)
        if self.detection_mode == "brightness":
            gray = cv2.cvtColor(proc_frame, cv2.COLOR_BGR2GRAY)
            _, full_mask = cv2.threshold(gray, self.threshold, 255, cv2.THRESH_BINARY)
        else:
            hsv = cv2.cvtColor(proc_frame, cv2.COLOR_BGR2HSV)
            full_mask = cv2.inRange(hsv, self.lower_hsv, self.upper_hsv)
        
        self.last_mask = full_mask
        
        # 3. Calculate Square Grid Slices
        # We use a square grid (1x1, 2x2, 3x3, 4x4) to ensure each 'Cel' 
        # maintains the 16:9 aspect ratio of the original canvas.
        num_targets = len(self.targets)
        import math
        if num_targets <= 1:
            grid_size = 1
        elif num_targets <= 4:
            grid_size = 2
        elif num_targets <= 9:
            grid_size = 3
        else:
            grid_size = 4
            
        cell_w = proc_w // grid_size
        cell_h = proc_h // grid_size
        
        results = {}
        for i, tname in enumerate(self.targets):
            # Calculate coordinates for this 'Cel' in the grid
            col = i % grid_size
            row = i // grid_size
            sx, sy, sw, sh = col * cell_w, row * cell_h, cell_w, cell_h
            
            # Extract this target's 'Slice' from the mask
            slice_mask = full_mask[sy:sy+sh, sx:sx+sw]
            
            # Find the largest blob in THIS slice
            contours, _ = cv2.findContours(slice_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                largest = max(contours, key=cv2.contourArea)
                area = cv2.contourArea(largest)
                
                if area >= 2:
                    bx, by, bw, bh = cv2.boundingRect(largest)

                    # Determine Center using Moments (CoM)
                    M = cv2.moments(largest)
                    if M["m00"] > 0:
                        cx = int(M["m10"] / M["m00"])
                        cy = int(M["m01"] / M["m00"])
                    else:
                        cx, cy = bx + bw // 2, by + bh // 2
                    
                    scale_x = self.canvas_width / sw
                    scale_y = self.canvas_height / sh
                    
                    # Final World Coordinates (Scaled to Canvas)
                    world_x = int(cx * scale_x)
                    world_y = int(cy * scale_y)
                    
                    # Map Bounds to World Space
                    world_bounds = [int(bx * scale_x), int(by * scale_y), int(bw * scale_x), int(bh * scale_y)]

                    # Pixel Scan: Extract granular hitboxes (Avatar Priority Budgeting)
                    pixel_grid = []
                    # Identify if this is the primary Avatar or a secondary source
                    avatar_name = self.config.get('camera_tracking', {}).get('avatar_source', 'Avatar')
                    is_avatar = (tname == avatar_name)
                    
                    # Set density and caps based on priority
                    if is_avatar:
                        step = max(2, 8 - self.precision)    # Higher density
                        max_points_per_cell = 600           # Higher cap
                    else:
                        step = max(6, 16 - self.precision)   # Lower density
                        max_points_per_cell = 150           # Lower cap

                    ys, xs = np.where(slice_mask > 0)
                    
                    if len(xs) > 0:
                        # Sample and limit based on priority budget
                        indices = np.arange(0, len(xs), step)
                        if len(indices) > max_points_per_cell:
                            indices = indices[np.linspace(0, len(indices)-1, max_points_per_cell, dtype=int)]
                        
                        sample_xs = xs[indices]
                        sample_ys = ys[indices]
                        
                        for px, py in zip(sample_xs, sample_ys):
                            # Force to standard Python int for JSON safety
                            world_px = int(px * scale_x)
                            world_py = int(py * scale_y)
                            pixel_grid.append([world_px, world_py])

                    results[tname] = {
                        "x": world_x,
                        "y": world_y,
                        "sx": sx, 
                        "sy": sy,
                        "sw": sw,
                        "sh": sh,
                        "mass": int(area * (scale_x * scale_y)),
                        "bounds": world_bounds,
                        "polygon": [],
                        "pixel_grid": pixel_grid,
                        "use_box": False,
                        "use_polygon": False,
                        "use_pixel": True
                    }
        
        self.target_results = results
        return results

    def get_debug_frame(self, frame):
        """Returns the frame with visualizations based on debug_mode."""
        if not HAS_OPENCV or frame is None: return frame
        fh, fw = frame.shape[:2]
        debug_frame = frame.copy()

        # 1. Overlay 'Stacked' Pixel Mask
        if self.last_mask is not None:
            num_targets = len(self.targets)
            if num_targets > 0:
                # Determine grid size (match process_frame logic)
                if num_targets <= 1: gs = 1
                elif num_targets <= 4: gs = 2
                elif num_targets <= 9: gs = 3
                else: gs = 4
                
                mh, mw = self.last_mask.shape[:2]
                cw, ch = mw // gs, mh // gs
                
                # Create a stacked mask
                stacked_mask = np.zeros((ch, cw), dtype=np.uint8)
                for i in range(min(num_targets, gs*gs)):
                    col, row = i % gs, i // gs
                    msx, msy = col * cw, row * ch
                    cel_mask = self.last_mask[msy:msy+ch, msx:msx+cw]
                    stacked_mask = cv2.bitwise_or(stacked_mask, cel_mask)
                
                # Resize and overlay
                display_mask = cv2.resize(stacked_mask, (fw, fh), interpolation=cv2.INTER_NEAREST)
                colored_mask = np.zeros_like(debug_frame)
                colored_mask[display_mask > 0] = (255, 255, 0)
                debug_frame = cv2.addWeighted(debug_frame, 0.6, colored_mask, 0.4, 0)

        # 2. Draw Targets (Center Dot & Text)
        for name, data in self.target_results.items():
            fx = int(data.get("x", 0) * (fw / self.canvas_width))
            fy = int(data.get("y", 0) * (fh / self.canvas_height))
            
            # Draw center dot
            cv2.circle(debug_frame, (fx, fy), 5, (0, 255, 255), -1)
            cv2.putText(debug_frame, name, (fx + 10, fy), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        
        return debug_frame
                
    def set_canvas_resolution(self, w, h):
        self.canvas_width = w
        self.canvas_height = h
        print("\n" + "="*50)
        print(f"!!! WORLD RESOLUTION SYNCED: {w}x{h} !!!")
        print("="*50 + "\n")

VISION = VisionEngine()
