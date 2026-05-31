# Changelog

<!-- Add new versions above this section. When bumping versions:
- Update APP_VERSION in the relevant main.js
- Ensure the UI version label reflects the new version
- Add a new section with the date and changes -->
<!-- Tag release locally after verification:
git tag v0.3.0
git push origin v0.3.0
-->

## v2.3.4 — UI overflow and preset row polish

- Fixed Obstacle Setup controls overflowing their container.
- Shortened and constrained obstacle volume sliders so rows stay inside the card.
- Improved preset row layout so saved preset summaries and action buttons fit cleanly.
- Right-aligned preset action buttons and added summary truncation.

## v2.3.3 — Column width balance polish

- Rebalanced the desktop column widths to be closer to an even split.
- Reduced excessive width in Obstacle Setup and Capture & Storage.
- Gave Core Motion / Rotation Feel / Sound Design and User Samples more breathing room.

## v2.3.2 — Logo and layout polish

- Fixed the logo display so it no longer crops.
- Swapped the primary columns so Core Motion / Rotation Feel / Sound Design are on the left and Obstacle Setup is on the right.
- Replaced the footer description with a more on-brand English tagline.

## v2.3.1 — UI spacing and layout polish

- Reduced excessive spacing around the logo and control cards.
- Removed the card border around the brand header.
- Moved Obstacle Setup into the primary workbench area for faster access.
- Prevented cards from stretching to equal heights unnecessarily.
- Updated `PROJECT.md` with revised layout rules.

## v2.3.0 — Dark UI refresh and branding

- Added logo branding to the Vol.2 UI.
- Switched the interface to a dark monochrome theme matching the logo.
- Reorganized controls into Core Motion, Rotation Feel, Sound Design, Capture & Storage, User Samples, and Obstacle Setup.
- Added responsive card-based layout for desktop and mobile.
- Preserved v2.1 real-time WAV recording and v2.2 browser-local User Samples behavior.
- Updated `PROJECT.md` with UI layout and styling rules.

## v2.2.0 — Browser-local user samples

- Added browser-local user samples stored in IndexedDB.
- Added multi-file audio import for WAV/MP3 recommended files.
- Added User Samples UI with Preview, Delete, Clear All, count, and status.
- Added User Samples to obstacle sample selectors above built-in samples.
- Added `obstacleSampleRefs` while preserving legacy `obstacleSampleIndices` fallback.
- User samples play through the existing master output and are included in real-time WAV recording.
- Updated `PROJECT.md` with user sample behavior, IndexedDB persistence, sampleRef compatibility, and smoke tests.

## v2.1.0 — Real-time WAV recording

- Added real-time WAV recording and download for the Vol.2 master output.
- Added an AudioWorklet pass-through recorder in `vol2/wav-recorder-worklet.js`.
- Added Recording UI with elapsed time, status, and Start Recording / Stop & Download WAV control.
- Added a 120-second maximum recording duration.
- Updated `PROJECT.md` with recording behavior, file structure, smoke tests, and future export candidates.

## v0.3.0 — GitHub Pages & Vol.2 default

- Set GitHub Pages entry point to Vol.2:
  - Root `index.html` is now a lightweight redirect to `./vol2/`.
  - Vol.1 is preserved as `index_v1.html` for local/manual use.
- Kept Vol.2's hit logic and audio pipeline unchanged.
- No functional changes to the simulators themselves, only routing/versioning.

## v0.2.0 — 2025-xx-xx

- Marked Vent Fan Beat Simulator Vol.2 as v0.2.0 with UI version label.
- Vol.2 uses delta-theta-based, forward-only hit detection with per-substep hit tolerance.
- Added per-obstacle volume and On/Off toggles with visual dimming for disabled obstacles.
- Presets expanded to 10 slots and persisted via localStorage (including obstacle enabled flags).
- Shared sample kit system via `samples/manifest.json` with per-obstacle sample selection.
- Sound & Response controls include Impact Dynamics, Soft Hit Low-Cut, Envelope Tail, and Mono/Poly voice modes.
- Light theme UI for Vol.2 with bottom-right version label.
