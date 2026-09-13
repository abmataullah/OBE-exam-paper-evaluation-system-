/**
 * PHASE 5: PDF TABULATION SHEET GENERATOR
 * ---------------------------------------
 * Produces a formal, black-and-white tabulation sheet PDF for an assessment.
 * The sheet shows:
 *   - University header (University of Chittagong / Department / Course)
 *   - A marks table: Student ID | Name | Q1 | Q2 | ... | Total | %
 *   - A CO attainment summary block beneath the table
 *   - Signature lines: Prepared By | Moderator | Chairman / Controller of Exams
 *
 * Implementation: build an HTML string from the data, then render it to PDF
 * with Puppeteer using a print CSS stylesheet (A4, narrow margins, no color).
 */
import puppeteer, { Browser } from 'puppeteer';
import { query } from '../db/pool';
import { calculateCourseAttainment } from './attainment';

interface TabulationInput {
  courseId: number;
  assessmentId: number;
  /** Names to pre-fill under the signature lines (optional). */
  preparedBy?: string;
  moderatorBy?: string;
  chairmanBy?: string;
}

interface StudentRow {
  university_roll: string;
  name: string;
  marks: (number | null)[]; // per question, aligned to questions order
  total: number;
  percentage: number; // of assessment total
}

interface QuestionMeta {
  question_no: number;
  co_code: string;
  max_marks: number;
}

interface CourseMeta {
  course_code: string;
  course_title: string;
  semester: string | null;
  department_name: string;
  program_name: string;
  assessment_title: string;
  assessment_type: string;
  total_marks: number;
  exam_date: string | null;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number | null): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Render a signature name, escaping real names but using &nbsp; for blanks. */
function sigName(name: string | undefined, fallback = ''): string {
  const v = (name ?? '').trim();
  if (v) return esc(v);
  return fallback || '&nbsp;';
}

/**
 * Build the full HTML document for the tabulation sheet.
 */
export function buildTabulationHtml(
  course: CourseMeta,
  questions: QuestionMeta[],
  students: StudentRow[],
  attainment: Awaited<ReturnType<typeof calculateCourseAttainment>>,
  signatures?: { preparedBy?: string; moderatorBy?: string; chairmanBy?: string }
): string {
  const qHeaders = questions
    .map(
      (q) =>
        `<th class="q"><span class="qno">Q${q.question_no}</span><span class="qmeta">${esc(
          q.co_code
        )} / ${fmt(q.max_marks)}</span></th>`
    )
    .join('');

  const totalCol = `<th class="total">Total<br/><small>${fmt(
    course.total_marks
  )}</small></th><th class="pct">%</th>`;

  const bodyRows = students
    .map((s, i) => {
      const cells = s.marks
        .map((m) => `<td class="mark">${fmt(m)}</td>`)
        .join('');
      return `<tr>
        <td class="sl">${i + 1}</td>
        <td class="roll">${esc(s.university_roll)}</td>
        <td class="name">${esc(s.name)}</td>
        ${cells}
        <td class="total">${fmt(s.total)}</td>
        <td class="pct">${s.percentage ? s.percentage.toFixed(1) : ''}</td>
      </tr>`;
    })
    .join('');

  // CO attainment summary rows
  const attainmentRows = attainment.co_attainments
    .map(
      (c) => `<tr>
        <td class="co">${esc(c.co_code)}</td>
        <td class="codesc">${esc(c.co_description)}</td>
        <td class="num">${c.total_students}</td>
        <td class="num">${c.students_attained}</td>
        <td class="num ${c.met_threshold ? 'pass' : 'fail'}">${c.attainment_percentage.toFixed(
          1
        )}%</td>
        <td class="num ${c.met_threshold ? 'pass' : 'fail'}">${
        c.met_threshold ? 'Attained' : 'Not Attained'
      }</td>
      </tr>`
    )
    .join('');

  const threshold = attainment.threshold;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Tabulation Sheet - ${esc(course.course_code)} - ${esc(course.assessment_title)}</title>
<style>
  @page { size: A4; margin: 12mm 10mm 14mm 10mm; }
  * { box-sizing: border-box; }
  html, body {
    font-family: "Times New Roman", Georgia, serif;
    color: #000; background: #fff; margin: 0; padding: 0;
    font-size: 11px;
  }
  .sheet { width: 100%; }
  .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
  .header h1 { font-size: 16px; margin: 0; letter-spacing: .5px; text-transform: uppercase; }
  .header h2 { font-size: 13px; margin: 2px 0 0; }
  .header h3 { font-size: 12px; margin: 2px 0 0; font-weight: normal; }
  .meta { display: flex; justify-content: space-between; font-size: 10.5px; margin: 6px 0 8px; }
  .meta div { white-space: nowrap; }
  .title-bar { text-align: center; font-weight: bold; font-size: 12px;
    border: 1px solid #000; padding: 4px; margin-bottom: 6px; text-transform: uppercase; }

  table { width: 100%; border-collapse: collapse; }
  table.marks th, table.marks td { border: 1px solid #000; padding: 3px 4px; }
  table.marks thead th { background: #e6e6e6; font-size: 10px; }
  table.marks th.q { text-align: center; width: 38px; }
  table.marks th.q .qno { display:block; font-weight:bold; }
  table.marks th.q .qmeta { display:block; font-weight:normal; font-size:8.5px; }
  table.marks th.total { width: 42px; }
  table.marks th.pct { width: 34px; }
  table.marks td.sl { text-align:center; width: 22px; }
  table.marks td.roll { text-align:center; white-space:nowrap; }
  table.marks td.name { white-space: nowrap; }
  table.marks td.mark { text-align:center; }
  table.marks td.total { text-align:center; font-weight:bold; }
  table.marks td.pct { text-align:center; }
  table.marks tbody tr:nth-child(even) td { background: #f4f4f4; }

  .section-title { margin-top: 14px; font-weight: bold; font-size: 12px;
    border-bottom: 1px solid #000; padding-bottom: 2px; }
  table.attain { margin-top: 6px; }
  table.attain th, table.attain td { border: 1px solid #000; padding: 3px 5px; font-size: 10.5px; }
  table.attain th { background:#e6e6e6; }
  table.attain td.co { font-weight:bold; text-align:center; width: 50px; }
  table.attain td.codesc { }
  table.attain td.num { text-align:center; width: 70px; }
  table.attain td.pass { font-weight:bold; }
  table.attain td.fail { font-weight:bold; }
  .note { font-size: 9.5px; margin-top: 4px; font-style: italic; }

  .signatures { margin-top: 26px; display: flex; justify-content: space-between; gap: 16px; }
  .sig { flex: 1; text-align: center; }
  .sig .line { border-top: 1px solid #000; margin-top: 34px; padding-top: 3px; font-size: 10.5px; }
  .sig .role { font-weight: bold; }
  .sig .name { font-size: 10px; }

  .footer { margin-top: 10px; font-size: 9px; text-align:center; border-top:1px solid #000; padding-top:3px; }
  @media print { .no-print { display:none; } }
</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <h1>University of Chittagong</h1>
      <h2>${esc(course.department_name)}</h2>
      <h3>${esc(course.program_name)}</h3>
    </div>

    <div class="title-bar">Tabulation Sheet &mdash; ${esc(course.assessment_title)}</div>

    <div class="meta">
      <div><b>Course:</b> ${esc(course.course_code)} &mdash; ${esc(course.course_title)}</div>
      <div><b>Semester:</b> ${esc(course.semester || '-')}</div>
      <div><b>Exam Date:</b> ${esc(course.exam_date || '-')}</div>
    </div>

    <table class="marks">
      <thead>
        <tr>
          <th>SL</th>
          <th>Student ID</th>
          <th>Student Name</th>
          ${qHeaders}
          ${totalCol}
        </tr>
      </thead>
      <tbody>
        ${bodyRows || '<tr><td colspan="' + (4 + questions.length + 2) + '">No student marks recorded.</td></tr>'}
      </tbody>
    </table>

    <div class="section-title">Course Outcome (CO) Attainment Summary</div>
    <table class="attain">
      <thead>
        <tr>
          <th>CO</th>
          <th>Description</th>
          <th>Total Students</th>
          <th>Attained</th>
          <th>Attainment %</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${attainmentRows || '<tr><td colspan="6">No CO data.</td></tr>'}
      </tbody>
    </table>
    <div class="note">
      Threshold: a student is counted as having attained a CO if they scored
      &ge; ${threshold}% on every question mapped to that CO. A CO is
      &ldquo;Attained&rdquo; when the overall attainment percentage &ge; ${threshold}%.
    </div>

    <div class="signatures">
      <div class="sig">
        <div class="line">
          <div class="role">Prepared By</div>
          <div class="name">${sigName(signatures?.preparedBy, 'Course Teacher')}</div>
        </div>
      </div>
      <div class="sig">
        <div class="line">
          <div class="role">Moderator</div>
          <div class="name">${sigName(signatures?.moderatorBy)}</div>
        </div>
      </div>
      <div class="sig">
        <div class="line">
          <div class="role">Chairman / Controller of Exams</div>
          <div class="name">${sigName(signatures?.chairmanBy)}</div>
        </div>
      </div>
    </div>

    <div class="footer">
      This is a system-generated tabulation sheet for OBE record-keeping.
      Generated on ${new Date().toLocaleString()}.
    </div>
  </div>
</body>
</html>`;
}

/**
 * Build the print-ready tabulation HTML (used for PDF rendering and for the
 * in-app print preview, which needs no Chrome).
 */
export async function generateTabulationHtml(input: TabulationInput): Promise<string> {
  const [course, questions, students, attainment] = await loadTabulationData(input);
  return buildTabulationHtml(course, questions, students, attainment, {
    preparedBy: input.preparedBy,
    moderatorBy: input.moderatorBy,
    chairmanBy: input.chairmanBy,
  });
}

/**
 * Render the tabulation HTML to a PDF buffer using Puppeteer.
 */
export async function generateTabulationPdf(
  input: TabulationInput
): Promise<{ buffer: Buffer; fileName: string; html: string }> {
  const [course, questions, students, attainment] = await loadTabulationData(input);
  const html = buildTabulationHtml(course, questions, students, attainment, {
    preparedBy: input.preparedBy,
    moderatorBy: input.moderatorBy,
    chairmanBy: input.chairmanBy,
  });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
    }));
    const safeCode = course.course_code.replace(/[^A-Za-z0-9]/g, '_');
    const safeTitle = course.assessment_title.replace(/\s+/g, '_');
    return {
      buffer,
      fileName: `Tabulation_${safeCode}_${safeTitle}.pdf`,
      html,
    };
  } finally {
    await browser.close();
  }
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath,
  });
}

async function loadTabulationData(
  input: TabulationInput
): Promise<
  [CourseMeta, QuestionMeta[], StudentRow[], Awaited<ReturnType<typeof calculateCourseAttainment>>]
> {
  const cRows = await query(
    `SELECT c.course_code, c.title AS course_title, c.semester,
            d.name AS department_name, p.name AS program_name,
            a.title AS assessment_title, a.type AS assessment_type,
            a.total_marks::float8 AS total_marks,
            a.exam_date::text AS exam_date
       FROM courses c
       JOIN programs p ON p.id = c.program_id
       JOIN departments d ON d.id = p.department_id
       JOIN assessments a ON a.course_id = c.id
      WHERE c.id = $1 AND a.id = $2`,
    [input.courseId, input.assessmentId]
  );
  if (cRows.rowCount === 0) {
    throw new Error(`Course ${input.courseId} / assessment ${input.assessmentId} not found`);
  }
  const course = cRows.rows[0] as CourseMeta;

  const qRows = await query<QuestionMeta>(
    `SELECT q.question_no, co.co_code, q.max_marks::float8 AS max_marks
       FROM questions q
       JOIN course_outcomes co ON co.id = q.co_id
      WHERE q.assessment_id = $1
      ORDER BY q.question_no`,
    [input.assessmentId]
  );
  const questions = qRows.rows;

  // Students + their marks per question (aligned to questions order).
  const sRows = await query<{
    university_roll: string;
    name: string;
    question_no: number;
    marks_obtained: number | null;
  }>(
    `SELECT s.university_roll, s.name, q.question_no,
            sm.marks_obtained::float8 AS marks_obtained
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       JOIN courses c ON c.id = e.course_id
       JOIN assessments a ON a.course_id = c.id
       JOIN questions q ON q.assessment_id = a.id
  LEFT JOIN student_marks sm ON sm.question_id = q.id AND sm.student_id = s.id
      WHERE c.id = $1 AND a.id = $2
      ORDER BY s.university_roll, q.question_no`,
    [input.courseId, input.assessmentId]
  );

  // Pivot rows into per-student arrays.
  const byRoll = new Map<string, StudentRow>();
  for (const r of sRows.rows) {
    let row = byRoll.get(r.university_roll);
    if (!row) {
      row = { university_roll: r.university_roll, name: r.name, marks: [], total: 0, percentage: 0 };
      byRoll.set(r.university_roll, row);
    }
  }
  // Ensure every student has an entry even if no marks
  const enrolled = await query<{ university_roll: string; name: string }>(
    `SELECT s.university_roll, s.name
       FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.course_id = $1 ORDER BY s.university_roll`,
    [input.courseId]
  );
  for (const e of enrolled.rows) {
    if (!byRoll.has(e.university_roll)) {
      byRoll.set(e.university_roll, {
        university_roll: e.university_roll,
        name: e.name,
        marks: [],
        total: 0,
        percentage: 0,
      });
    }
  }

  // Fill marks aligned to questions order
  const qOrder = new Map(questions.map((q, i) => [q.question_no, i]));
  for (const r of sRows.rows) {
    const row = byRoll.get(r.university_roll)!;
    const idx = qOrder.get(r.question_no);
    if (idx === undefined) continue;
    row.marks[idx] = r.marks_obtained;
  }
  // Ensure arrays are full length (null for ungraded)
  for (const row of byRoll.values()) {
    for (let i = 0; i < questions.length; i++) {
      if (row.marks[i] === undefined) row.marks[i] = null;
    }
    row.total = row.marks.reduce<number>((sum, m) => sum + (m ?? 0), 0);
    row.percentage =
      course.total_marks > 0 ? (row.total / course.total_marks) * 100 : 0;
  }

  const students = Array.from(byRoll.values());

  const attainment = await calculateCourseAttainment({
    courseId: input.courseId,
    assessmentId: input.assessmentId,
  });

  return [course, questions, students, attainment];
}
