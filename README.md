# OBE Evaluator

Outcome-Based Education (OBE) grading and attainment system for traditional
public universities (modeled on the University of Chittagong). A teacher fills
one Excel template offline, uploads it, and gets back a formal tabulation sheet
(PDF) with Course Outcome attainment — ready to print, sign, envelope, and send
to the Controller of Examinations.

Ships as **two products from one codebase**:

| Product | Where | Database | Users |
|---|---|---|---|
| **Desktop `.exe`** (free, offline) | banglai.cloud/homemade-software download | Embedded PostgreSQL (PGlite, file-based) | Individual teachers |
| **Web app** (online, central) | banglai.cloud | PostgreSQL server | Department / central submission |

Both run the *same* backend services and the *same* React UI.

## The teacher's workflow

1. **Download** the blank Excel template from the app.
2. **Fill it offline**: department, program, course, semester, assessment,
   question max-marks (Q1..Q10), student IDs, names, and marks.
3. **Upload** the filled file. The software validates every cell (e.g.
   `Row 25, Q2: Score 16 exceeds max marks 15`) and, if clean, creates the
   course, assessment, questions, students and marks in one transaction.
4. **Review** CO attainment (per-CO %, threshold 60% by default).
5. **Download the Tabulation Sheet PDF**, fill signature names, print, sign,
   envelope, dispatch.

## Repository layout

```
backend/    Express + TypeScript API. Excel generate/parse, attainment, PDF.
            Runs on PostgreSQL (web) or PGlite (desktop) via DB_DRIVER.
frontend/   React 19 + Vite + Tailwind v4 single-page UI (shared by both).
desktop/    Electron wrapper: embeds backend + frontend + PGlite -> Windows .exe
samples/    Example filled templates for testing (one valid, one with errors).
```

## Quick start (development)

Prereqs: Node.js 18+ (24 tested). PostgreSQL 17 only for the web target.

```bash
# Backend (web mode, PostgreSQL)
cd backend && cp .env.example .env   # set PG_* credentials
npm install && npm run build && npm run migrate
npm run dev                          # http://localhost:4000

# Frontend
cd frontend && npm install && npm run dev   # http://localhost:5173 (proxies /api -> 4000)

# Desktop (embedded DB, no PostgreSQL needed)
cd desktop && npm install
npm run build:all && npm start
```

## Build the Windows installer

```bash
cd desktop
npm run dist          # -> release/OBE-Evaluator-1.0.0-x64-setup.exe  (NSIS installer)
                      # -> release/OBE-Evaluator-1.0.0-portable.exe   (no install)
```

On Windows, run the electron-builder step with `CSC_IDENTITY_AUTO_DISCOVERY=false`
(no code signing). Both artifacts are ~94 MB.

### Windows notes
- If Electron reports `app is undefined`, the env var `ELECTRON_RUN_AS_NODE=1`
  is set in your shell (some IDEs set it). Unset it before running Electron.
- PDF generation uses an installed Chrome or Edge (auto-detected). If neither
  is present, everything else works and the PDF button shows an error.
- Desktop data lives in `%APPDATA%\obe-evaluator-desktop\pgdata`; a log is
  written to `%APPDATA%\obe-evaluator-desktop\obe-evaluator.log`.

## API (both targets)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/template` | Blank grading template (.xlsx) |
| POST | `/api/process` | Upload filled template (multipart `file`) → creates everything, returns `{courseId, assessmentId}` or per-cell errors (HTTP 422) |
| GET | `/api/courses` | List courses |
| GET | `/api/courses/:c/assessments` | List assessments |
| GET | `/api/courses/:c/assessments/:a/attainment?threshold=60` | CO attainment JSON |
| GET | `/api/courses/:c/assessments/:a/tabulation?preparedBy=&moderatorBy=&chairmanBy=` | Tabulation PDF (`&format=html` for preview) |
| GET/PATCH | `/api/assessments/:a/sheet` | Approval workflow (draft→submitted→moderated→verified→published) |

## Attainment rule

A student *attains* a CO when they score ≥ threshold (default 60%) on **every**
question mapped to that CO. CO attainment % = attained students / all students.
Ungraded students count as not attained. When the template's CO column is left
blank, Q1→CO1, Q2→CO2, … automatically.

## Tests

End-to-end integration test boots the real server against an isolated,
file-backed PGlite and drives the full teacher workflow over HTTP (template
download → upload valid → attainment → tabulation → upload invalid →
approval workflow). No external PostgreSQL needed.

```bash
cd backend && npm test          # builds + runs node:test (7 assertions)
```

## License

MIT — free forever, no ads, no telemetry.
