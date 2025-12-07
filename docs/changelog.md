# Changelog

<!-- Add new versions above this section. When bumping versions:
- Update APP_VERSION in the relevant main.js
- Ensure the UI version label reflects the new version
- Add a new section with the date and changes -->

## v0.2.0 — 2025-xx-xx

- Marked Vent Fan Beat Simulator Vol.2 as v0.2.0 with UI version label.
- Vol.2 uses delta-theta-based, forward-only hit detection with per-substep hit tolerance.
- Added per-obstacle volume and On/Off toggles with visual dimming for disabled obstacles.
- Presets expanded to 10 slots and persisted via localStorage (including obstacle enabled flags).
- Shared sample kit system via `samples/manifest.json` with per-obstacle sample selection.
- Sound & Response controls include Impact Dynamics, Soft Hit Low-Cut, Envelope Tail, and Mono/Poly voice modes.
- Light theme UI for Vol.2 with bottom-right version label.

