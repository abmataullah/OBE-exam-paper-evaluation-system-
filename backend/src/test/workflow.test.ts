/**
 * End-to-end integration test for the OBE backend.
 *
 * Boots the REAL compiled server (dist/server.js) as a subprocess against an
 * isolated, file-backed PGlite database, applies the schema, then drives the
 * full teacher workflow over HTTP:
 *
 *   1. GET  /api/template                  -> blank .xlsx
 *   2. POST /api/process (valid file)      -> { ok:true, courseId, assessmentId }
 *   3. GET  /api/courses                   -> list contains the new course
 *   4. GET  .../attainment?threshold=60    -> 4 COs, expected %, met_threshold
 *   5. GET  .../tabulation?format=html    -> print-ready HTML
 *   6. POST /api/process (invalid file)    -> 422 with per-cell errors
 *   7. PATCH .../sheet (legal & illegal)   -> workflow transitions enforced
 *
 * Uses only Node's built-in test runner (node:test) + global fetch. No extra
 * dependencies. Run with:  npm test   (from backend/)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { LAYOUT as L } from '../services/excelGenerator';

const PORT = 48731; // fixed high port; tests are single-instance
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess | null = null;
let dataDir = '';

/** Fill the blank template the way a teacher would (valid dataset). */
async function fillValid(blankPath: string, outPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(blankPath) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Grading');
  assert.ok(ws, 'Grading sheet present in blank template');

  ws.getCell(L.ROW_DEPT, 2).value = 'Department of Computer Science & Engineering';
  ws.getCell(L.ROW_PROGRAM, 2).value = 'B.Sc. in Computer Science & Engineering';
  ws.getCell(L.ROW_COURSE, 2).value = 'CSE 401';
  ws.getCell(L.ROW_COURSE, 5).value = 'Software Engineering';
  ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
  ws.getCell(L.ROW_SEMESTER, 5).value = '2024-08-15';
  ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Midterm Examination';
  ws.getCell(L.ROW_ASSESSMENT, 6).value = 'midterm';
  ws.getCell(L.ROW_ASSESSMENT, 8).value = 40;

  const maxes = [10, 15, 8, 7];
  maxes.forEach((m, i) => { ws.getCell(L.ROW_Q_FIRST + i, L.COL_Q_MAX).value = m; });

  const students = [
    ['19301001', 'Rahim Uddin', [8, 12, 6, 5]],
    ['19301002', 'Karim Ahmed', [7, 13, 7, 6]],
    ['19301003', 'Fatima Begum', [9, 14, 8, 7]],
    ['19301004', 'Nadia Sultana', [5, 8, 4, 3]],
    ['19301005', 'Imran Hossain', [6, 11, 5, 5]],
  ] as [string, string, number[]][];

  students.forEach(([roll, name, marks], i) => {
    const r = L.ROW_STUDENT_FIRST + i;
    ws.getCell(r, L.COL_ROLL).value = roll;
    ws.getCell(r, L.COL_NAME).value = name;
    marks.forEach((m, q) => { ws.getCell(r, L.COL_Q_FIRST + q).value = m; });
  });

  writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));
}

/** Same as fillValid but with two deliberate out-of-range marks. */
async function fillInvalid(blankPath: string, outPath: string): Promise<void> {
  await fillValid(blankPath, outPath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(outPath) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Grading')!;
  // Row 2 student: Q2 = 16 (> max 15); Row 4 student: Q4 = -1
  ws.getCell(L.ROW_STUDENT_FIRST + 1, L.COL_Q_FIRST + 1).value = 16;
  ws.getCell(L.ROW_STUDENT_FIRST + 3, L.COL_Q_FIRST + 3).value = -1;
  writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('server did not become ready in time');
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'obe-test-'));
  // Apply schema in this process, then close PGlite so the server subprocess
  // can open the same file-backed data dir exclusively.
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DATA_DIR = dataDir;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initPglite, execPglite, endPool } = require('../db/pool');
  await initPglite(dataDir);
  const schemaSql = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await execPglite(schemaSql);
  await endPool();

  server = spawn(process.execPath, [join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      DB_DRIVER: 'pglite',
      PGLITE_DATA_DIR: dataDir,
      PORT: String(PORT),
      FRONTEND_DIST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', () => { /* swallow */ });
  server.stderr?.on('data', () => { /* swallow */ });
  await waitReady();
});

after(() => {
  if (server) server.kill();
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  }
});

describe('OBE backend — full workflow', () => {
  let courseId = 0;
  let assessmentId = 0;
  const blankPath = join(tmpdir(), 'obe-blank.xlsx');
  const validPath = join(tmpdir(), 'obe-filled.xlsx');
  const invalidPath = join(tmpdir(), 'obe-invalid.xlsx');

  test('GET /api/template returns a valid .xlsx', async () => {
    const r = await fetch(`${BASE}/api/template`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /spreadsheetml/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 5000, 'template buffer non-trivial');
    writeFileSync(blankPath, buf);
  });

  test('POST /api/process with valid file creates course + assessment', async () => {
    await fillValid(blankPath, validPath);
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(validPath)]), 'filled.xlsx');
    const r = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(r.status, 200);
    const body = await r.json() as { ok: boolean; courseId: number | null; assessmentId: number | null };
    assert.equal(body.ok, true);
    assert.ok(body.courseId, 'courseId returned');
    assert.ok(body.assessmentId, 'assessmentId returned');
    courseId = body.courseId!;
    assessmentId = body.assessmentId!;
  });

  test('GET /api/courses lists the new course', async () => {
    const r = await fetch(`${BASE}/api/courses`);
    const list = await r.json() as Array<{ id: number; course_code: string }>;
    assert.ok(list.some((c) => c.id === courseId && c.course_code === 'CSE 401'));
  });

  test('GET .../attainment computes CO attainment @60%', async () => {
    const r = await fetch(`${BASE}/api/courses/${courseId}/assessments/${assessmentId}/attainment?threshold=60`);
    assert.equal(r.status, 200);
    const rep = await r.json() as {
      course_code: string; threshold: number;
      co_attainments: Array<{ co_code: string; total_students: number; students_attained: number; attainment_percentage: number; met_threshold: boolean }>;
    };
    assert.equal(rep.course_code, 'CSE 401');
    assert.equal(rep.threshold, 60);
    assert.equal(rep.co_attainments.length, 4, 'four COs (Q1..Q4)');
    // 4 of 5 students score >= 60% on every question -> 80% per CO
    for (const co of rep.co_attainments) {
      assert.equal(co.total_students, 5);
      assert.equal(co.students_attained, 4);
      assert.equal(co.attainment_percentage, 80);
      assert.equal(co.met_threshold, true);
    }
  });

  test('GET .../tabulation?format=html returns print-ready HTML', async () => {
    const r = await fetch(`${BASE}/api/courses/${courseId}/assessments/${assessmentId}/tabulation?format=html&preparedBy=Ata`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const html = await r.text();
    assert.match(html, /Tabulation Sheet/);
    assert.match(html, /CSE 401/);
  });

  test('POST /api/process with invalid file returns 422 + per-cell errors', async () => {
    await fillInvalid(blankPath, invalidPath);
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(invalidPath)]), 'invalid.xlsx');
    const r = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(r.status, 422);
    const body = await r.json() as { ok: boolean; errors: Array<{ row: number; column: string; message: string }> };
    assert.equal(body.ok, false);
    assert.ok(body.errors.length >= 2, 'at least two validation errors');
    assert.ok(body.errors.some((e) => /exceeds max marks/.test(e.message)));
    assert.ok(body.errors.some((e) => /negative/.test(e.message)));
  });

  test('PATCH .../sheet enforces the approval workflow', async () => {
    // Current status after a successful upload is 'submitted' (set on creation).
    // Legal: submitted -> moderated
    let r = await fetch(`${BASE}/api/assessments/${assessmentId}/sheet`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'moderated', actor: 'Prof. Mod' }),
    });
    assert.equal(r.status, 200);
    let body = await r.json() as { ok: boolean; previous: string; next: string };
    assert.equal(body.ok, true);
    assert.equal(body.previous, 'submitted');
    assert.equal(body.next, 'moderated');

    // Illegal: moderated -> published (must go via verified)
    r = await fetch(`${BASE}/api/assessments/${assessmentId}/sheet`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    assert.equal(r.status, 409);
    const err = await r.json() as { error: string };
    assert.match(err.error, /Cannot transition/);
  });
});
