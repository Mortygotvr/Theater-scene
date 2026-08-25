---
description: Ensure original repository folders remain untouched when working with versioned or experimental copies
globs: ["**/*"]
always_on: true
---

# Preserve Original Project Folders

When working on experimental branches, version copies, or sandbox duplicates (e.g., `Control Panel 1.01` created from `Control Panel`):
1. **Never modify files in the original project directory** unless explicitly instructed by the user.
2. Direct all edits, compilation, test executions, and builds exclusively to the newly designated copy or version folder (e.g., `c:\Users\death\repo\Control Panel 1.01`).
3. Ensure original repository baselines remain pristine.
