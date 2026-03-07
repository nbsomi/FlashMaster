# FlashMaster

FlashMaster is an offline-first study app built with React, Vite, Dexie, and Google Drive sync. It combines flashcard review, quizzes, analytics, voice features, CSV-based content import, and profile-based progress tracking in a single browser application.

## What It Does

- Stores study data locally in IndexedDB through Dexie.
- Uses Google sign-in as the main access flow.
- Syncs profile data to Google Drive.
- Supports flash review with SM-2 style spaced repetition.
- Supports quizzes with timers, adaptive selection, and explanations.
- Imports question banks from CSV files.
- Supports text, image, audio, and several interactive question renderers.
- Includes analytics and leaderboard-style progress summaries.

## Current Product Shape

- The main application logic lives in `src/FlashMaster.jsx`.
- The app uses state-based screen navigation instead of a router.
- Questions are currently loaded through CSV import in the UI flow.
- Missing image questions can use Google image search if configured.
- There is no Cloudflare image generation or local SVG image fallback in the current build.

## Tech Stack

- React 18
- Vite 5
- Dexie 3
- Recharts
- Google Identity Services
- Google Drive REST API

## Project Structure

```text
.
|- src/
|  |- main.jsx
|  |- App.jsx
|  |- FlashMaster.jsx
|- documentation/
|  |- index.html
|- package.json
|- vite.config.js
|- README.md
```

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create or update `.env` with the variables the current app uses:

```env
VITE_GOOGLE_CLIENT_ID=your_google_oauth_client_id
VITE_GOOGLE_IMAGE_SEARCH_API_KEY=your_google_custom_search_api_key
VITE_GOOGLE_IMAGE_SEARCH_CX=your_google_programmable_search_engine_id
```

Notes:

- `VITE_GOOGLE_CLIENT_ID` is required for the normal login flow.
- Google image search is optional, but image questions without a `media` URL will not show an image unless it is configured.

### 3. Start development server

```bash
npm run dev
```

### 4. Build for production

```bash
npm run build
```

### 5. Preview production build

```bash
npm run preview
```

## CSV Import

FlashMaster expects question content to come from CSV import in the current UI.

Common columns:

- `question_text`
- `type`
- `difficulty`
- `subtopic`
- `explanation`
- `media`
- `answer`
- `answer-capital`, `answer-currency`, or other `answer-*` variant columns

Example:

```csv
question_text,type,difficulty,subtopic,explanation,media,answer-capital,answer-currency
India,Text,medium,Geography,Answer one requested field,,New Delhi,Rupee
Identify this fruit,Image,easy,Objects,Image URL optional if Google image search is configured,,Apple,
Identify this anthem,Audio,medium,Culture,Listen and answer,https://example.com/audio.mp3,National Anthem,
```

## Main Screens

- Google login
- Profiles
- Subjects
- Topics
- Subtopics
- Questions
- Flash study
- Quiz
- Analytics
- Planner
- Settings
- Leaderboard

## Persistence and Sync

- Local persistence uses IndexedDB via Dexie.
- Study progress is profile-scoped.
- Google Drive sync uploads filtered profile snapshots.
- Auto-sync is debounced by 4 seconds after relevant data changes.
- Local backup export and import are available from Settings.
- Optional encrypted backup export is supported through the in-app settings flow.

## Documentation

Detailed HTML documentation is available here:

- `documentation/index.html`

That document covers:

- runtime architecture
- IndexedDB schema
- screen map
- CSV import behavior
- sync and backup flow
- configuration details
- maintenance notes

## Development Notes

- `src/FlashMaster.jsx` is intentionally large and centralizes most app behavior.
- If you refactor the codebase, the first clean split would likely be:
  storage, sync, renderers, study engines, and screens.
- If you change the CSV format, schema, or sync payload shape, update both this README and `documentation/index.html`.

## License

No license file is currently included in this repository.
