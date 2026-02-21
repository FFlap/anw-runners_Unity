# Unity

Unity is a browser extension that turns any active tab into a chat workspace.

## What It Does

- Works on regular webpages and YouTube videos.
- Builds local tab context by extracting visible text (and YouTube transcript when available).
- Lets you ask questions in a chat UI.
- Returns answers grounded only in the current tab's extracted context.
- Provides source chips per answer that jump to supporting text:
  - Webpages: inline highlight + scroll to matching text.
  - YouTube: seek to transcript timestamp when available.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Run extension dev server:

```bash
npm run dev:stable
```

3. Add your OpenRouter API key in Unity settings inside the popup.
4. Ensure microphone permissions are set to **Allow** for voice dictation:
   - `chrome-extension://<your-extension-id>` for popup voice input.
   - `youtube.com` for in-page YouTube voice input.

## Build

```bash
npm run build
```

## Notes

- Answers are intentionally constrained to tab-local context.
- If context is insufficient, Unity returns an insufficient-evidence style answer instead of fabricating details.
- Voice dictation requires microphone permission set to **Allow**.
