/**
 * OBE Evaluator Ã¢â‚¬â€ Electron Main Process
 *
 * Starts an embedded PostgreSQL (PGlite) database, runs the schema migration
 * on first launch, starts the Express API server on a local port, and opens
 * a BrowserWindow loading the built React frontend. The teacher just
 * double-clicks the .exe Ã¢â‚¬â€ no PostgreSQL install, no server config, fully
 * offline.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

// ---- Paths ---------------------------------------------------------------
// The build script copies the compiled backend + frontend into dist/ next to
// this file, so they ship inside the app bundle and `require()` resolves the
// shared node_modules in both dev and packaged mode.
const backendDir = path.join(__dirname, 'backend');
const frontendDir = path.join(__dirname, 'frontend');
const schemaPath = path.join(backendDir, 'db', 'schema.sql');
const dataDir = path.join(app.getPath('userData'), 'pgdata');

// ---- Environment for the embedded backend --------------------------------
process.env.DB_DRIVER = 'pglite';
process.env.PGLITE_DATA_DIR = dataDir;
process.env.PORT = '0'; // 0 = let the OS pick a free port (we override below)
process.env.NODE_ENV = 'production';
process.env.FRONTEND_DIST = frontendDir;

// Detect a Chrome/Edge binary for Puppeteer (PDF generation). If none found,
// PDF generation will show an error but everything else works.
process.env.PUPPETEER_EXECUTABLE_PATH = detectChrome();

function detectChrome(): string {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

let mainWindow: BrowserWindow | null = null;
let serverPort = 0;

// Persist logs to userData so packaged-app failures are diagnosable
// (stdout/stderr of a windowed .exe are not visible to the user).
const logFile = path.join(app.getPath('userData'), 'obe-evaluator.log');
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => log('[desktop] uncaughtException:', e));
process.on('unhandledRejection', (e) => log('[desktop] unhandledRejection:', e as Error));

async function runMigration(): Promise<void> {
  log('[desktop] Loading pool module from:', path.join(backendDir, 'db', 'pool.js'));
  const { initPglite, execPglite, query } = require(path.join(backendDir, 'db', 'pool.js'));
  log('[desktop] Initializing PGlite at:', dataDir);
  await initPglite(dataDir);
  log('[desktop] PGlite initialized.');

  // Check if schema already applied (look for a core table).
  log('[desktop] Checking schema...');
  const check = await query(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables
       WHERE table_name = 'departments'
     ) AS exists`
  );
  if (!check.rows[0]?.exists) {
    log('[desktop] Applying schema from:', schemaPath);
    const sql = fs.readFileSync(schemaPath, 'utf8');
    // execPglite uses PGlite's exec() which handles multi-statement SQL
    // (BEGIN/COMMIT, CREATE TYPE, functions, triggers) without prepared
    // statements.
    await execPglite(sql);
    log('[desktop] Schema applied.');
  } else {
    log('[desktop] Schema already present.');
  }
}

async function seedDemoData(): Promise<void> {
  const { query } = require(path.join(backendDir, 'db', 'pool.js'));
  // Only seed if there are no courses yet.
  const r = await query('SELECT COUNT(*)::int AS cnt FROM courses');
  if (r.rows[0]?.cnt === 0) {
    const seedPath = path.join(backendDir, 'db', 'seed.js');
    if (fs.existsSync(seedPath)) {
      const { runSeed } = require(seedPath);
      await runSeed(); // properly await the async seed
      log('[desktop] Demo data seeded.');
    }
  } else {
    log('[desktop] Data already present, skipping seed.');
  }
}

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const port = 4000 + Math.floor(Math.random() * 1000);
    process.env.PORT = String(port);
    log('[desktop] Starting server on port', port);

    try {
      require(path.join(backendDir, 'server.js'));
      log('[desktop] Server module loaded.');
    } catch (e) {
      log('[desktop] Server require failed:', e);
      reject(e);
      return;
    }

    // Wait for the server to be ready.
    const tryConnect = (attempts: number) => {
      if (attempts <= 0) {
        reject(new Error('Server did not start in time.'));
        return;
      }
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve(port);
        } else {
          setTimeout(() => tryConnect(attempts - 1), 200);
        }
      });
      req.on('error', () => setTimeout(() => tryConnect(attempts - 1), 200));
      req.end();
    };
    setTimeout(() => tryConnect(25), 300);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'OBE Evaluation System',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the frontend from the local Express server.
  await mainWindow.loadURL(`http://localhost:${serverPort}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- App lifecycle -------------------------------------------------------
app.whenReady().then(async () => {
  try {
    log('[desktop] App ready. Data directory:', dataDir);
    log('[desktop] Backend dir:', backendDir);
    log('[desktop] Frontend dir:', frontendDir);
    log('[desktop] Schema path:', schemaPath);
    await runMigration();
    log('[desktop] Migration done.');
    // Desktop starts empty: the teacher creates data by uploading a filled
    // template. Set OBE_SEED_DEMO=1 to load demo data for testing.
    if (process.env.OBE_SEED_DEMO === '1') {
      await seedDemoData();
      log('[desktop] Seed done.');
    }
    serverPort = await startServer();
    log('[desktop] Server on port', serverPort);
    await createWindow();
    log('[desktop] Window created.');
  } catch (err) {
    log('[desktop] Startup failed:', err);
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'OBE Evaluator Ã¢â‚¬â€ Startup Error',
      err instanceof Error ? err.message : String(err)
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', async () => {
  if (mainWindow === null && serverPort > 0) {
    await createWindow();
  }
});

// IPC: let the renderer ask for the server port (if needed for direct API calls)
ipcMain.handle('get-server-port', () => serverPort);
