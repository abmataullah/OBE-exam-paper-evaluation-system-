# OBE Evaluator — Desktop (Windows)

Electron wrapper that turns the backend + frontend into a single offline
Windows application with an embedded PostgreSQL database (PGlite). No server,
no database install — the teacher double-clicks the `.exe`.

## How it boots

`src/main.ts`:

1. Sets `DB_DRIVER=pglite`, `PGLITE_DATA_DIR=%APPDATA%\obe-evaluator-desktop\pgdata`.
2. Initialises PGlite; on first launch applies `schema.sql` (via `execPglite`).
3. Starts the bundled Express server on a random local port (4000–4999),
   serving both `/api` and the built frontend.
4. Opens a `BrowserWindow` on that URL.
5. Detects Chrome/Edge for PDF generation.

Logs: `%APPDATA%\obe-evaluator-desktop\obe-evaluator.log`.

## Build

```bash
npm install
npm run icon         # regenerates resources/icon.png (zero-dependency generator)
npm run build:all    # builds backend + frontend, assembles dist/
npm start            # run in dev
npm run dist         # NSIS installer + portable .exe -> release/
```

`scripts/build-all.js` copies `../backend/dist` → `dist/backend` and
`../frontend/dist` → `dist/frontend`, so everything lives inside `app.asar`
and `require()` resolves this package's `node_modules`.

`@electric-sql/pglite` is listed in `asarUnpack` — its `.wasm` must be a
real file on disk. `backend/src/db/pglitePool.ts` requires it from the
unpacked path when running inside an asar.

## Gotchas (Windows)

- **`ELECTRON_RUN_AS_NODE=1`** in the environment makes Electron behave as
  plain Node (`app` is undefined). Some IDE terminals set it — unset first.
- electron-builder's code-signing helper fails to extract without admin
  (symlink privilege). Signing is disabled in `package.json`
  (`signAndEditExecutable: false`); also set `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- Do not test the exe through a shell pipe that may be closed early; a closed
  stdout pipe terminates Chromium. Launch with `Start-Process` or normally.
- `OBE_SEED_DEMO=1` seeds demo data on first launch (testing only).

## Release artifacts

| File | Purpose |
|---|---|
| `release/OBE-Evaluator-<v>-x64-setup.exe` | NSIS installer (Start-menu + desktop shortcut, per-user) |
| `release/OBE-Evaluator-<v>-portable.exe` | Single portable executable |
