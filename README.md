# AI Job Application Autofill — Setup Guide

## 1. Get pdf.js (required, one-time, manual step)

This sandbox has no internet access, so the two pdf.js library files are
**not included** in this zip. You need to add them yourself:

1. Go to https://github.com/mozilla/pdf.js/releases
2. Download the latest `pdfjs-<version>-dist.zip` asset (this is the
   pre-built distribution, not the source code zip).
3. Unzip it, and copy these two files into this project's `lib/` folder:
   - `build/pdf.min.js` → `lib/pdf.min.js`
   - `build/pdf.worker.min.js` → `lib/pdf.worker.min.js`

Your `lib/` folder should then contain exactly:
```
lib/pdf.min.js
lib/pdf.worker.min.js
```

Why this is required: Manifest V3's Content Security Policy blocks
extensions from loading and executing scripts from a remote CDN
(`script-src` is locked to `'self'`), so pdf.js must be bundled and
loaded as a local file. Loading it locally also means PDF parsing
keeps working even if a CDN is down or blocked.

## 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project folder (the one containing `manifest.json`)

## 3. Get a Gemini API key

Get a free key from https://aistudio.google.com/apikey

## 4. Use it

1. Click the extension icon → click **Resume & API key settings**
   (this opens a full browser tab — not the small popup)
2. In that tab: paste your Gemini API key, upload your resume PDF,
   wait for "PDF parsed" confirmation, then click **Save Resume & API Key**
3. Go to a job application page (LinkedIn, Indeed, Greenhouse, Lever,
   Workday, or any site — see note below)
4. Click the extension icon → **Fill This Page**

### Why settings are a separate tab, not the popup

Chrome closes toolbar popups the instant they lose focus — and opening
the native PDF file picker does exactly that. If the resume upload UI
lived in the popup, the popup (and your in-progress upload) would just
vanish with no error the moment the file dialog opened. Moving the
settings UI to a full tab (via `chrome.runtime.openOptionsPage()`)
avoids this, since normal tabs don't auto-close on focus loss. The
toolbar popup is now just a "Fill This Page" trigger, which is instant
and never opens a file dialog, so it's safe to keep as a popup.

## Notes on site coverage

`manifest.json` only auto-injects `content.js` on a handful of known
job sites (LinkedIn, Indeed, Greenhouse, Lever, Workday). For any other
site, the popup's "Fill This Page" button falls back to injecting
`content.js` on demand via `chrome.scripting.executeScript`, which only
needs the `activeTab` permission — so it still works on unlisted sites
without requiring broad host permissions up front.

## Files

- `manifest.json` — MV3 manifest, permissions, background/content script registration
- `popup.html` / `popup.js` — UI for uploading resume PDF + API key, and triggering fill
- `content.js` — scrapes job description + form fields, injects AI answers into the DOM
- `background.js` — service worker that calls the Gemini API (avoids CORS issues)
- `lib/` — pdf.js library (you add this — see step 1 above)
- `icons/` — placeholder extension icons (feel free to replace with your own)

## Security notes

- Your Gemini API key and resume text are stored in `chrome.storage.local`,
  which is local to your browser profile and not synced or sent anywhere
  except directly to Google's Gemini API endpoint.
- Consider using a restricted/scoped API key and keeping an eye on usage
  in Google AI Studio, since the key lives in extension storage.
# Job-Application-autofill
