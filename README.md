# 🎙️ FormVoice – Accessible Form Assistant

A Chrome extension that helps visually impaired users fill web forms using voice and saved profile data.

## Architecture

```
User activates extension
       │
       ▼
Content Script detects form fields
       │
       ├──► Qdrant (fetch saved profile data)
       │
       ├──► Lyzr Agent (decide: autofill vs. ask user)
       │         │
       │    autofill ──► fill field silently
       │    ask_user ──► Omi (voice capture) ──► fill field
       │
       └──► TTS readback of all values
                 │
            User says YES ──► Submit form
            User says NO  ──► Cancel
```

## Setup

### 1. Install in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked** → select this folder

### 2. Configure API Keys
Click the ⚙ icon in the popup, or go to the extension options page and enter:
- **Qdrant URL** — your cluster URL from qdrant.io
- **Qdrant API Key**
- **Qdrant Collection** — default: `user_profile`
- **Lyzr API Key**
- **Lyzr Agent ID** — create a form-filling agent at lyzr.ai
- **Omi API Key**

### 3. Seed Your Profile in Qdrant
Create a collection and upsert a point with your profile payload:
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+1-555-0100",
  "address": "123 Main St, Springfield",
  "date_of_birth": "1990-05-15"
}
```

### 4. Use
1. Navigate to any web page with a form
2. Click the 🎙️ extension icon
3. Press **Start Form Assistant**
4. Listen and respond to voice prompts

## File Structure
```
form-assistant/
├── manifest.json
├── icons/
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background.js   ← Qdrant + Lyzr API calls
    ├── content.js      ← Form detection, Omi voice, TTS, orchestration
    ├── overlay.css     ← Visual overlay styles
    ├── popup.html/js   ← Extension popup
    └── options.html/js ← API key settings
```

## Notes
- Add real 48×128px PNG icons to `/icons/` before publishing
- The Omi WebSocket URL may need updating based on their latest API docs
- Lyzr agent should be configured with a form-filling system prompt
