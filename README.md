## GYMISHAN – Cardio Proof (Camera-only)

Mobile-first single-page app to keep yourself accountable for daily cardio. You generate a randomized plan across your machines, then you must capture live camera photos within ± slack minutes for each segment. No gallery uploads. No images stored.

### Features
- Camera-only capture via `getUserMedia` (no file picker).
- Random split of total cardio time across your machines.
- Slack window: allow ±N minutes for capture.
- Time-gated progression: next segment starts when you capture the first photo.
- Machine verification with on-device enrollment + perceptual hash (no API usage, offline).
- Local calendar shows done/missed days (today is marked done when session completes).
- Privacy-friendly: images are not uploaded or persisted.

### Getting started
1. Serve the folder with any static server. Examples:
   - Python: `python3 -m http.server 5173` then open `http://localhost:5173`.
   - Node: `npx serve .` then open the printed URL.
2. On first load, allow camera permissions on your mobile browser.

### Usage
1. Configure total minutes and slack window.
2. Manage your machine list (defaults: Elliptical, Treadmill). Enroll each machine by tapping Enroll and capturing a reference frame of the console.
3. Generate plan, then Start session (requires all machines in the plan to be enrolled).
4. Open camera and wait until the countdown is within the allowed window.
5. Capture proof for segment 1; this immediately starts segment 2 timer (prevents early capture).
6. Repeat for the next segment; a pHash check ensures the captured frame matches the enrolled machine.
7. When all segments complete, today is marked done in the calendar.

### Notes
- This app does not analyze the machine screen; it relies on the timer gating and slack windows to deter cheating.
- Machine verification uses a compact perceptual hash (dHash). Keep framing consistent during enrollment and proofs for best results. Threshold is tuned conservatively in `app.js` (search for `threshold = 12`).
- If you close the tab mid-session, the timer state is saved locally and restored on reopen.
- To reset, use the Reset button in Setup.

### Roadmap
- Optional server to persist history across devices.
- Additional heuristics (e.g., OCR of timer digits) if needed.
- Support for more than 2 segments with custom distributions.

