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

// ============================================================================
// REGRESSION TESTS — one per bug fix
// ============================================================================

describe('Bug fixes — regression tests', () => {
  const blankPath = join(tmpdir(), 'obe-blank.xlsx');
  const blankPath2 = join(tmpdir(), 'obe-blank2.xlsx');

  // Re-download a fresh blank template for these tests
  before(async () => {
    const r = await fetch(`${BASE}/api/template`);
    writeFileSync(blankPath2, Buffer.from(await r.arrayBuffer()));
  });

  // Bug 2: blank semester must be rejected with a clear validation error,
  // not silently produce 0% attainment.
  test('Bug 2: blank semester returns 422 with "Semester is required"', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Grading')!;
    const L = require('../services/excelGenerator').LAYOUT;
    ws.getCell(L.ROW_DEPT, 2).value = 'Dept of CSE';
    ws.getCell(L.ROW_PROGRAM, 2).value = 'BSc CSE';
    ws.getCell(L.ROW_COURSE, 2).value = 'CSE 999';
    ws.getCell(L.ROW_COURSE, 5).value = 'Test Course';
    ws.getCell(L.ROW_SEMESTER, 2).value = ''; // BLANK semester
    ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Quiz';
    ws.getCell(L.ROW_ASSESSMENT, 6).value = 'quiz';
    ws.getCell(L.ROW_ASSESSMENT, 8).value = 10;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_MAX).value = 10;
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_ROLL).value = '99999999';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_NAME).value = 'Test Student';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_Q_FIRST).value = 7;
    const outPath = join(tmpdir(), 'obe-nosemester.xlsx');
    writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));

    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'nosemester.xlsx');
    const resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 422);
    const body = await resp.json() as { ok: boolean; errors: Array<{ message: string }> };
    assert.equal(body.ok, false);
    assert.ok(body.errors.some((e) => /Semester is required/.test(e.message)));
  });

  // Bug 3: custom (non-sequential) CO codes must not crash with 500.
  test('Bug 3: custom CO codes (Q1→CO2, Q2→CO4) succeed, not 500', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Grading')!;
    const L = require('../services/excelGenerator').LAYOUT;
    ws.getCell(L.ROW_DEPT, 2).value = 'Dept of CSE';
    ws.getCell(L.ROW_PROGRAM, 2).value = 'BSc CSE';
    ws.getCell(L.ROW_COURSE, 2).value = 'CSE 998';
    ws.getCell(L.ROW_COURSE, 5).value = 'Custom CO Course';
    ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
    ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Midterm';
    ws.getCell(L.ROW_ASSESSMENT, 6).value = 'midterm';
    ws.getCell(L.ROW_ASSESSMENT, 8).value = 25;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_MAX).value = 10;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_CO).value = 'CO2'; // non-sequential
    ws.getCell(L.ROW_Q_FIRST + 1, L.COL_Q_MAX).value = 15;
    ws.getCell(L.ROW_Q_FIRST + 1, L.COL_Q_CO).value = 'CO4'; // non-sequential
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_ROLL).value = '88888001';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_NAME).value = 'Test Student';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_Q_FIRST).value = 8;
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_Q_FIRST + 1).value = 12;
    const outPath = join(tmpdir(), 'obe-customco.xlsx');
    writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));

    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'customco.xlsx');
    const resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 200, `expected 200, got ${resp.status}`);
    const body = await resp.json() as { ok: boolean; courseId: number; assessmentId: number };
    assert.equal(body.ok, true);

    // Verify attainment shows CO2 and CO4 (not CO1/CO3)
    const att = await fetch(`${BASE}/api/courses/${body.courseId}/assessments/${body.assessmentId}/attainment?threshold=60`);
    const attBody = await att.json() as { co_attainments: Array<{ co_code: string }> };
    const coCodes = attBody.co_attainments.map((c) => c.co_code);
    assert.ok(coCodes.includes('CO2'), 'CO2 present');
    assert.ok(coCodes.includes('CO4'), 'CO4 present');
    assert.equal(coCodes.length, 2, 'exactly two COs');
  });

  // Bug 4: re-uploading into a moderated/verified/published assessment must
  // be rejected with 409, not silently destroy marks.
  test('Bug 4: re-upload into moderated sheet returns 409', async () => {
    // Upload a fresh file
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Grading')!;
    const L = require('../services/excelGenerator').LAYOUT;
    ws.getCell(L.ROW_DEPT, 2).value = 'Dept of CSE';
    ws.getCell(L.ROW_PROGRAM, 2).value = 'BSc CSE';
    ws.getCell(L.ROW_COURSE, 2).value = 'CSE 997';
    ws.getCell(L.ROW_COURSE, 5).value = 'Re-upload Guard';
    ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
    ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Quiz 1';
    ws.getCell(L.ROW_ASSESSMENT, 6).value = 'quiz';
    ws.getCell(L.ROW_ASSESSMENT, 8).value = 10;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_MAX).value = 10;
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_ROLL).value = '77777001';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_NAME).value = 'Guard Test';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_Q_FIRST).value = 7;
    const outPath = join(tmpdir(), 'obe-guard1.xlsx');
    writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));

    let fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'guard1.xlsx');
    let resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 200);
    const body = await resp.json() as { ok: boolean; courseId: number; assessmentId: number };

    // Advance to moderated
    resp = await fetch(`${BASE}/api/assessments/${body.assessmentId}/sheet`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'moderated', actor: 'Mod' }),
    });
    assert.equal(resp.status, 200);

    // Re-upload the same file — must be rejected with 409
    fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'guard1.xlsx');
    resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 409);
    const errBody = await resp.json() as { error: string };
    assert.match(errBody.error, /already "moderated"/);
  });

  // Bug 5: met_threshold must be consistent with the rounded attainment %.
  test('Bug 5: met_threshold matches rounded attainment_percentage', async () => {
    // Use the first test's course (courseId/assessmentId from outer scope are
    // not accessible here, so re-upload a fresh one with known data).
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Grading')!;
    const L = require('../services/excelGenerator').LAYOUT;
    ws.getCell(L.ROW_DEPT, 2).value = 'Dept of CSE';
    ws.getCell(L.ROW_PROGRAM, 2).value = 'BSc CSE';
    ws.getCell(L.ROW_COURSE, 2).value = 'CSE 996';
    ws.getCell(L.ROW_COURSE, 5).value = 'Rounding Test';
    ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
    ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Quiz R';
    ws.getCell(L.ROW_ASSESSMENT, 6).value = 'quiz';
    ws.getCell(L.ROW_ASSESSMENT, 8).value = 10;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_MAX).value = 10;
    // 3 students: 2 score 7/10 (70% >= 67% threshold → attain), 1 scores 5/10 (50% < 67% → not)
    // → 2/3 = 66.67% → rounded 66.7%. With threshold 67: 66.7 < 67 → met_threshold=false
    for (let i = 0; i < 3; i++) {
      const r = L.ROW_STUDENT_FIRST + i;
      ws.getCell(r, L.COL_ROLL).value = `6666600${i + 1}`;
      ws.getCell(r, L.COL_NAME).value = `Student ${i + 1}`;
      ws.getCell(r, L.COL_Q_FIRST).value = i < 2 ? 7 : 5;
    }
    const outPath = join(tmpdir(), 'obe-rounding.xlsx');
    writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));

    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'rounding.xlsx');
    let resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 200);
    const body = await resp.json() as { ok: boolean; courseId: number; assessmentId: number };

    resp = await fetch(`${BASE}/api/courses/${body.courseId}/assessments/${body.assessmentId}/attainment?threshold=67`);
    const att = await resp.json() as {
      co_attainments: Array<{ attainment_percentage: number; met_threshold: boolean }>;
    };
    assert.equal(att.co_attainments.length, 1);
    const co = att.co_attainments[0];
    // 2 of 3 students attained → 66.666...% → rounded to 66.7
    assert.equal(co.attainment_percentage, 66.7);
    // 66.7 < 67 → not met (consistent with the displayed percentage)
    assert.equal(co.met_threshold, false);
  });

  // Bug 6: tabulation PDF/HTML must honor the threshold query param.
  test('Bug 6: tabulation HTML honors ?threshold= param', async () => {
    // Re-use the rounding test's course (CSE 996) — find it
    const coursesResp = await fetch(`${BASE}/api/courses`);
    const courses = await coursesResp.json() as Array<{ id: number; course_code: string }>;
    const course = courses.find((c) => c.course_code === 'CSE 996');
    assert.ok(course, 'CSE 996 course exists');
    const assessResp = await fetch(`${BASE}/api/courses/${course!.id}/assessments`);
    const assess = await assessResp.json() as Array<{ id: number; title: string }>;
    assert.ok(assess.length > 0);

    // Default threshold (60) → should show "Threshold: ... 60%"
    let r = await fetch(`${BASE}/api/courses/${course!.id}/assessments/${assess[0].id}/tabulation?format=html`);
    let html = await r.text();
    assert.match(html, /Threshold:/);

    // Custom threshold (75) → the note should mention 75
    r = await fetch(`${BASE}/api/courses/${course!.id}/assessments/${assess[0].id}/tabulation?format=html&threshold=75`);
    html = await r.text();
    assert.match(html, /75%/);
  });

  // Enhancement: delete assessment endpoint
  test('Enhancement: DELETE /api/assessments/:id removes an assessment', async () => {
    // Upload a fresh file to create an assessment
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Grading')!;
    const L = require('../services/excelGenerator').LAYOUT;
    ws.getCell(L.ROW_DEPT, 2).value = 'Dept of CSE';
    ws.getCell(L.ROW_PROGRAM, 2).value = 'BSc CSE';
    ws.getCell(L.ROW_COURSE, 2).value = 'CSE 995';
    ws.getCell(L.ROW_COURSE, 5).value = 'Delete Test';
    ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
    ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Quiz Del';
    ws.getCell(L.ROW_ASSESSMENT, 6).value = 'quiz';
    ws.getCell(L.ROW_ASSESSMENT, 8).value = 10;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_MAX).value = 10;
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_ROLL).value = '55555001';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_NAME).value = 'Del Test';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_Q_FIRST).value = 7;
    const outPath = join(tmpdir(), 'obe-delete.xlsx');
    writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));

    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'delete.xlsx');
    let resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 200);
    const body = await resp.json() as { ok: boolean; courseId: number; assessmentId: number };

    // Delete it
    resp = await fetch(`${BASE}/api/assessments/${body.assessmentId}`, { method: 'DELETE' });
    assert.equal(resp.status, 200);
    const delBody = await resp.json() as { ok: boolean };
    assert.equal(delBody.ok, true);

    // Verify it's gone (attainment should 404/error)
    resp = await fetch(`${BASE}/api/courses/${body.courseId}/assessments`);
    const list = await resp.json() as Array<{ id: number }>;
    assert.ok(!list.some((a) => a.id === body.assessmentId), 'assessment removed from list');
  });

  test('Enhancement: DELETE blocked for moderated sheet (409)', async () => {
    // Upload + advance to moderated, then try to delete
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Grading')!;
    const L = require('../services/excelGenerator').LAYOUT;
    ws.getCell(L.ROW_DEPT, 2).value = 'Dept of CSE';
    ws.getCell(L.ROW_PROGRAM, 2).value = 'BSc CSE';
    ws.getCell(L.ROW_COURSE, 2).value = 'CSE 994';
    ws.getCell(L.ROW_COURSE, 5).value = 'Delete Guard';
    ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
    ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Quiz DelGuard';
    ws.getCell(L.ROW_ASSESSMENT, 6).value = 'quiz';
    ws.getCell(L.ROW_ASSESSMENT, 8).value = 10;
    ws.getCell(L.ROW_Q_FIRST, L.COL_Q_MAX).value = 10;
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_ROLL).value = '44444001';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_NAME).value = 'Guard';
    ws.getCell(L.ROW_STUDENT_FIRST, L.COL_Q_FIRST).value = 7;
    const outPath = join(tmpdir(), 'obe-delguard.xlsx');
    writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));

    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(outPath)]), 'delguard.xlsx');
    let resp = await fetch(`${BASE}/api/process`, { method: 'POST', body: fd });
    assert.equal(resp.status, 200);
    const body = await resp.json() as { ok: boolean; assessmentId: number };

    // Advance to moderated
    resp = await fetch(`${BASE}/api/assessments/${body.assessmentId}/sheet`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'moderated', actor: 'Mod' }),
    });
    assert.equal(resp.status, 200);

    // Delete should be blocked
    resp = await fetch(`${BASE}/api/assessments/${body.assessmentId}`, { method: 'DELETE' });
    assert.equal(resp.status, 409);
    const err = await resp.json() as { error: string };
    assert.match(err.error, /moderated/);
  });

  // Enhancement: template includes an Instructions sheet
  test('Enhancement: blank template includes an Instructions sheet', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(blankPath2) as unknown as ArrayBuffer);
    const instr = wb.getWorksheet('Instructions');
    assert.ok(instr, 'Instructions sheet exists');
    const titleCell = instr.getCell(1, 1).value;
    assert.match(String(titleCell), /How to fill/);
  });
});
