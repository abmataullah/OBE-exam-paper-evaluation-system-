/**
 * FILLED TEMPLATE PARSER + PROCESSOR
 * ----------------------------------
 * Parses a teacher-filled blank template and creates ALL database records:
 * department, program, course, course outcomes, assessment, questions,
 * students, enrollments, and student marks — in one transaction.
 *
 * Validation:
 *  - Required header fields (department, program, course code, course title,
 *    assessment title, total marks) must be present.
 *  - At least one question with max marks > 0.
 *  - At least one student with a Student ID.
 *  - No mark may exceed the question's max marks.
 *  - No negative marks.
 *
 * On any hard error, returns a structured error list (row + column + message)
 * and writes NOTHING to the DB (all-or-nothing).
 *
 * Returns the created course_id and assessment_id so the frontend can
 * immediately navigate to attainment / tabulation.
 */
import ExcelJS from 'exceljs';
import { withTransaction } from '../db/pool';
import { HttpError } from './excelGenerator';
import type { MarkValidationError } from '../types';

const SHEET = 'Grading';

// Must match excelGenerator.ts LAYOUT
const ROW_DEPT = 3;
const ROW_PROGRAM = 4;
const ROW_COURSE = 5;
const ROW_SEMESTER = 6;
const ROW_ASSESSMENT = 7;
const ROW_Q_HEADER = 10;
const ROW_Q_FIRST = 11;
const Q_COUNT = 10;
const ROW_Q_LAST = ROW_Q_FIRST + Q_COUNT - 1;
const ROW_STUDENT_HEADER = 23;
const ROW_STUDENT_FIRST = 24;
const STUDENT_COUNT = 60;
const COL_Q_NO = 1;
const COL_Q_MAX = 2;
const COL_Q_CO = 3;
const COL_ROLL = 2;
const COL_NAME = 3;
const COL_Q_FIRST = 4;

// Must match the assessment_type_enum in schema.sql
const VALID_ASSESSMENT_TYPES = ['quiz', 'midterm', 'assignment', 'lab', 'final', 'project'];

interface ParsedQuestion {
  questionNo: number;
  maxMarks: number;
  coCode: string | null; // optional, auto-assigned if null
}

interface ParsedStudent {
  roll: string;
  name: string;
  marks: (number | null)[]; // per question, aligned to questions array
}

interface ParsedTemplate {
  department: string;
  program: string;
  courseCode: string;
  courseTitle: string;
  semester: string;
  examDate: string;
  assessmentTitle: string;
  assessmentType: string;
  totalMarks: number;
  questions: ParsedQuestion[];
  students: ParsedStudent[];
}

export interface ProcessResult {
  ok: boolean;
  errors: MarkValidationError[];
  courseId: number | null;
  assessmentId: number | null;
}

function cellText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getCell(row, col).value;
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result ?? '');
  return String(v).trim();
}

function cellNumber(ws: ExcelJS.Worksheet, row: number, col: number): number | null {
  const v = ws.getCell(row, col).value;
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number') return r;
  }
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? null : n;
}

function parseTemplate(wb: ExcelJS.Workbook): { data: ParsedTemplate; errors: MarkValidationError[] } {
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`Missing "${SHEET}" sheet.`);

  const errors: MarkValidationError[] = [];

  // Header block
  const department = cellText(ws, ROW_DEPT, 2);
  const program = cellText(ws, ROW_PROGRAM, 2);
  const courseCode = cellText(ws, ROW_COURSE, 2);
  const courseTitle = cellText(ws, ROW_COURSE, 5);
  const semester = cellText(ws, ROW_SEMESTER, 2);
  const examDate = cellText(ws, ROW_SEMESTER, 5);
  const assessmentTitle = cellText(ws, ROW_ASSESSMENT, 2);
  const assessmentType = (cellText(ws, ROW_ASSESSMENT, 6) || 'midterm').toLowerCase().trim();
  const totalMarks = cellNumber(ws, ROW_ASSESSMENT, 8);

  if (!department) errors.push({ row: ROW_DEPT, column: 'Department', student_roll: '', message: 'Department is required.' });
  if (!program) errors.push({ row: ROW_PROGRAM, column: 'Program', student_roll: '', message: 'Program is required.' });
  if (!courseCode) errors.push({ row: ROW_COURSE, column: 'Course Code', student_roll: '', message: 'Course Code is required.' });
  if (!courseTitle) errors.push({ row: ROW_COURSE, column: 'Course Title', student_roll: '', message: 'Course Title is required.' });
  if (!assessmentTitle) errors.push({ row: ROW_ASSESSMENT, column: 'Assessment', student_roll: '', message: 'Assessment Title is required.' });
  if (totalMarks == null || totalMarks <= 0) errors.push({ row: ROW_ASSESSMENT, column: 'Total Marks', student_roll: '', message: 'Total Marks must be a positive number.' });
  if (!semester) errors.push({ row: ROW_SEMESTER, column: 'Semester', student_roll: '', message: 'Semester is required (e.g. 2024-1/2). Students are enrolled per semester.' });
  if (assessmentType && !VALID_ASSESSMENT_TYPES.includes(assessmentType)) {
    errors.push({ row: ROW_ASSESSMENT, column: 'Type', student_roll: '', message: `Assessment type "${assessmentType}" is invalid. Must be one of: ${VALID_ASSESSMENT_TYPES.join(', ')}.` });
  }

  // Question definitions
  const questions: ParsedQuestion[] = [];
  for (let i = 0; i < Q_COUNT; i++) {
    const r = ROW_Q_FIRST + i;
    const maxMarks = cellNumber(ws, r, COL_Q_MAX);
    if (maxMarks == null || maxMarks <= 0) continue; // empty question row = skip
    const coRaw = cellText(ws, r, COL_Q_CO).toUpperCase();
    questions.push({
      questionNo: i + 1,
      maxMarks,
      coCode: coRaw || null,
    });
  }
  if (questions.length === 0) {
    errors.push({ row: ROW_Q_FIRST, column: 'Max Marks', student_roll: '', message: 'At least one question with max marks must be defined.' });
  }

  // Students + marks
  const students: ParsedStudent[] = [];
  for (let i = 0; i < STUDENT_COUNT; i++) {
    const r = ROW_STUDENT_FIRST + i;
    const roll = cellText(ws, r, COL_ROLL);
    if (!roll) continue; // empty row = skip
    const name = cellText(ws, r, COL_NAME);
    if (!name) {
      errors.push({ row: r, column: 'Student Name', student_roll: roll, message: 'Student Name is required.' });
    }
    const marks: (number | null)[] = [];
    for (let q = 0; q < questions.length; q++) {
      const col = COL_Q_FIRST + q;
      const m = cellNumber(ws, r, col);
      marks.push(m);
    }
    students.push({ roll, name, marks });
  }
  if (students.length === 0) {
    errors.push({ row: ROW_STUDENT_FIRST, column: 'Student ID', student_roll: '', message: 'At least one student must be entered.' });
  }

  // Detect duplicate Student IDs — the DB enforces uniqueness, so the second
  // entry would silently overwrite the first. Warn the teacher explicitly.
  const seenRolls = new Map<string, number>(); // roll -> first Excel row
  for (const s of students) {
    const firstRow = seenRolls.get(s.roll);
    if (firstRow !== undefined) {
      const studentRowIdx = students.indexOf(s);
      const excelRow = ROW_STUDENT_FIRST + studentRowIdx;
      errors.push({
        row: excelRow,
        column: 'Student ID',
        student_roll: s.roll,
        message: `Duplicate Student ID "${s.roll}" — also entered on row ${firstRow}. Each student must have a unique ID.`,
      });
    } else {
      const idx = students.indexOf(s);
      seenRolls.set(s.roll, ROW_STUDENT_FIRST + idx);
    }
  }

  // Validate marks against question max marks
  for (const s of students) {
    for (let qi = 0; qi < s.marks.length; qi++) {
      const m = s.marks[qi];
      if (m == null) continue; // blank = not graded, allowed
      const q = questions[qi];
      const colLabel = `Q${q.questionNo}`;
      // Find the actual Excel row for this student
      const studentRowIdx = students.indexOf(s);
      const excelRow = ROW_STUDENT_FIRST + studentRowIdx;
      if (m < 0) {
        errors.push({ row: excelRow, column: colLabel, student_roll: s.roll, message: `Score ${m} is negative (must be 0..${q.maxMarks}).` });
      } else if (m > q.maxMarks) {
        errors.push({ row: excelRow, column: colLabel, student_roll: s.roll, message: `Score ${m} exceeds max marks ${q.maxMarks}.` });
      }
    }
  }

  const data: ParsedTemplate = {
    department: department || 'Unknown',
    program: program || 'Unknown',
    courseCode: courseCode || 'UNKNOWN',
    courseTitle: courseTitle || 'Unknown',
    semester: semester || '',
    examDate: examDate || '',
    assessmentTitle: assessmentTitle || 'Assessment',
    assessmentType: assessmentType || 'midterm',
    totalMarks: totalMarks || 0,
    questions,
    students,
  };

  return { data, errors };
}

/**
 * Main entry: parse + validate + (if clean) persist everything.
 */
export async function processFilledTemplate(fileBuffer: Buffer): Promise<ProcessResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fileBuffer as unknown as ArrayBuffer);

  const { data, errors } = parseTemplate(wb);

  if (errors.length > 0) {
    return { ok: false, errors, courseId: null, assessmentId: null };
  }

  // All clear — create everything in one transaction.
  const result = await withTransaction(async (client) => {
    // 1. Department (find or create)
    let deptId: number;
    const dept = await client.query<{ id: number }>(
      `SELECT id FROM departments WHERE LOWER(name) = LOWER($1)`, [data.department]
    );
    if (dept.rows.length > 0) {
      deptId = dept.rows[0].id;
    } else {
      const code = data.department.substring(0, 20).toUpperCase().replace(/[^A-Z]/g, '');
      const r = await client.query<{ id: number }>(
        `INSERT INTO departments(name, code) VALUES ($1, $2) RETURNING id`,
        [data.department, code || 'DEPT']
      );
      deptId = r.rows[0].id;
    }

    // 2. Program (find or create)
    let progId: number;
    const prog = await client.query<{ id: number }>(
      `SELECT id FROM programs WHERE department_id = $1 AND LOWER(name) = LOWER($2)`, [deptId, data.program]
    );
    if (prog.rows.length > 0) {
      progId = prog.rows[0].id;
    } else {
      const pcode = data.program.substring(0, 30).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = await client.query<{ id: number }>(
        `INSERT INTO programs(department_id, name, code) VALUES ($1, $2, $3) RETURNING id`,
        [deptId, data.program, pcode || 'PROG']
      );
      progId = r.rows[0].id;
    }

    // 3. Course (find or create)
    let courseId: number;
    const course = await client.query<{ id: number }>(
      `SELECT id FROM courses WHERE program_id = $1 AND course_code = $2`,
      [progId, data.courseCode]
    );
    if (course.rows.length > 0) {
      courseId = course.rows[0].id;
    } else {
      const r = await client.query<{ id: number }>(
        `INSERT INTO courses(program_id, course_code, title, semester) VALUES ($1, $2, $3, $4) RETURNING id`,
        [progId, data.courseCode, data.courseTitle, data.semester || null]
      );
      courseId = r.rows[0].id;
    }

    // 4. Course Outcomes — create the CO codes actually referenced by the
    //    questions. If the teacher specified CO codes, use those; for
    //    questions with no CO specified, auto-assign Q1→CO1, Q2→CO2, etc.
    //    Collect the full set of CO codes needed (deduplicated, ordered).
    const coCodesNeeded: string[] = [];
    const seen = new Set<string>();
    for (const q of data.questions) {
      const code = q.coCode || `CO${q.questionNo}`;
      if (!seen.has(code)) {
        seen.add(code);
        coCodesNeeded.push(code);
      }
    }

    const coIds = new Map<string, number>();
    for (const coCode of coCodesNeeded) {
      let co = await client.query<{ id: number }>(
        `SELECT id FROM course_outcomes WHERE course_id = $1 AND co_code = $2`,
        [courseId, coCode]
      );
      if (co.rows.length === 0) {
        const coNum = parseInt(coCode.replace(/[^0-9]/g, ''), 10) || coCodesNeeded.indexOf(coCode) + 1;
        co = await client.query<{ id: number }>(
          `INSERT INTO course_outcomes(course_id, co_code, description, display_order)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [courseId, coCode, `Course Outcome ${coNum}`, coNum]
        );
      }
      coIds.set(coCode, co.rows[0].id);
    }

    // 5. Assessment (find or create)
    let assessmentId: number;
    const examDate = data.examDate || null;
    const assess = await client.query<{ id: number }>(
      `SELECT id FROM assessments WHERE course_id = $1 AND title = $2`,
      [courseId, data.assessmentTitle]
    );
    if (assess.rows.length > 0) {
      assessmentId = assess.rows[0].id;
      // Update total marks
      await client.query(
        `UPDATE assessments SET total_marks = $1 WHERE id = $2`,
        [data.totalMarks, assessmentId]
      );
    } else {
      const r = await client.query<{ id: number }>(
        `INSERT INTO assessments(course_id, title, type, total_marks, exam_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [courseId, data.assessmentTitle, data.assessmentType, data.totalMarks, examDate]
      );
      assessmentId = r.rows[0].id;
    }

    // 6. Grading sheet — create if new, or guard against re-uploading into a
    //    sheet that has already advanced past the editable stages.
    const sheet = await client.query<{ id: number; status: string }>(
      `SELECT id, status FROM grading_sheets WHERE assessment_id = $1`, [assessmentId]
    );
    if (sheet.rows.length > 0) {
      const existingStatus = sheet.rows[0].status;
      if (existingStatus === 'moderated' || existingStatus === 'verified' || existingStatus === 'published') {
        throw new HttpError(409, `Cannot re-upload: assessment is already "${existingStatus}". Roll it back to "submitted" first.`);
      }
    } else {
      await client.query(
        `INSERT INTO grading_sheets(assessment_id, status) VALUES ($1, 'submitted')`,
        [assessmentId]
      );
    }

    // 7. Questions — delete old + insert new (clean slate per upload)
    await client.query(`DELETE FROM student_marks WHERE question_id IN (SELECT id FROM questions WHERE assessment_id = $1)`, [assessmentId]);
    await client.query(`DELETE FROM questions WHERE assessment_id = $1`, [assessmentId]);

    const questionIds: number[] = [];
    for (const q of data.questions) {
      const coCode = q.coCode || `CO${q.questionNo}`;
      const coId = coIds.get(coCode);
      if (!coId) {
        throw new Error(`CO ${coCode} not found. Define it in the Course Outcomes first.`);
      }
      const r = await client.query<{ id: number }>(
        `INSERT INTO questions(assessment_id, question_no, co_id, blooms_level, max_marks)
         VALUES ($1, $2, $3, 'understand', $4) RETURNING id`,
        [assessmentId, q.questionNo, coId, q.maxMarks]
      );
      questionIds.push(r.rows[0].id);
    }

    // 8. Students + enrollments + marks
    const semester = data.semester || null;
    for (const s of data.students) {
      let studentId: number;
      const stu = await client.query<{ id: number }>(
        `SELECT id FROM students WHERE university_roll = $1`, [s.roll]
      );
      if (stu.rows.length > 0) {
        studentId = stu.rows[0].id;
      } else {
        const r = await client.query<{ id: number }>(
          `INSERT INTO students(university_roll, name, program_id) VALUES ($1, $2, $3) RETURNING id`,
          [s.roll, s.name, progId]
        );
        studentId = r.rows[0].id;
      }

      // Enrollment
      if (semester) {
        await client.query(
          `INSERT INTO enrollments(course_id, student_id, semester)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [courseId, studentId, semester]
        );
      }

      // Marks
      for (let qi = 0; qi < s.marks.length; qi++) {
        const m = s.marks[qi];
        if (m == null) continue;
        await client.query(
          `INSERT INTO student_marks(question_id, student_id, marks_obtained)
           VALUES ($1, $2, $3)
           ON CONFLICT (question_id, student_id)
           DO UPDATE SET marks_obtained = EXCLUDED.marks_obtained, graded_at = now()`,
          [questionIds[qi], studentId, m]
        );
      }
    }

    return { courseId, assessmentId };
  });

  return { ok: true, errors: [], courseId: result.courseId, assessmentId: result.assessmentId };
}

/**
 * Fetch the current status of a grading sheet (used by the
 * approval-workflow endpoints).
 */
export async function getSheetStatus(assessmentId: number) {
  const { query } = await import('../db/pool');
  const r = await query(
    `SELECT id, assessment_id, status, prepared_by, moderated_by, verified_by,
            published_by, submitted_at, moderated_at, verified_at, published_at,
            notes, updated_at
       FROM grading_sheets WHERE assessment_id = $1`,
    [assessmentId]
  );
  return r.rows[0] ?? null;
}
