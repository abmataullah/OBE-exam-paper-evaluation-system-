/**
 * BLANK TEMPLATE GENERATOR
 * -------------------------
 * Produces a blank .xlsx the teacher downloads and fills in entirely offline.
 * Single sheet ("Grading") with three blocks:
 *
 *   1. Course/Assessment header block (rows 1-7): labeled cells for the
 *      teacher to type department, program, course code/title, semester,
 *      exam date, assessment title/type/total marks.
 *
 *   2. Question definitions block (rows 9-19): Q No | Max Marks | CO (optional).
 *      Pre-filled with Q1..Q10 rows; teacher fills max marks (and optionally
 *      which CO each question targets). CO left blank → auto-assigned
 *      Q1→CO1, Q2→CO2, etc.
 *
 *   3. Student marks block (rows 21+): SL | Student ID | Student Name |
 *      Q1 | Q2 | ... | Q10 | Total. 50 blank rows pre-formatted. The Total
 *      column is a SUM formula. Data validation limits each Q column to
 *      0..100 (strict per-question max is enforced on upload since the
 *      teacher defines max marks in the same file).
 *
 * A hidden __meta sheet records the row/column layout so the parser can
 * find each block reliably without guessing.
 */
import ExcelJS from 'exceljs';

const SHEET = 'Grading';
const META = '__meta';

// Layout constants — the parser reads these from __meta, but they're
// defined here as the single source of truth.
const ROW_TITLE = 1;
const ROW_DEPT = 3;
const ROW_PROGRAM = 4;
const ROW_COURSE = 5;      // Course Code | Course Title
const ROW_SEMESTER = 6;    // Semester | Exam Date
const ROW_ASSESSMENT = 7;  // Assessment Title | Type | Total Marks
const ROW_Q_HEADER = 10;   // Q No | Max Marks | CO (optional)
const ROW_Q_FIRST = 11;   // first question row
const Q_COUNT = 10;        // Q1..Q10
const ROW_Q_LAST = ROW_Q_FIRST + Q_COUNT - 1;
const ROW_STUDENT_HEADER = ROW_Q_LAST + 3; // 23
const STUDENT_COUNT = 60;
const ROW_STUDENT_FIRST = ROW_STUDENT_HEADER + 1; // 24

// Column layout for the student block:
//  A=SL, B=Student ID, C=Student Name, D..M=Q1..Q10, N=Total
const COL_SL = 1;
const COL_ROLL = 2;
const COL_NAME = 3;
const COL_Q_FIRST = 4; // Q1 = column D
const COL_TOTAL = COL_Q_FIRST + Q_COUNT; // column N (14)

// Question block columns: A=Q No, B=Max Marks, C=CO
const COL_Q_NO = 1;
const COL_Q_MAX = 2;
const COL_Q_CO = 3;

function thinBorder(): Partial<ExcelJS.Borders> {
  const b: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF000000' } };
  return { top: b, left: b, bottom: b, right: b };
}

function labelCell(ws: ExcelJS.Worksheet, row: number, col: number, text: string) {
  const cell = ws.getCell(row, col);
  cell.value = text;
  cell.font = { bold: true };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  cell.border = thinBorder();
}

function inputCell(ws: ExcelJS.Worksheet, row: number, col: number) {
  const cell = ws.getCell(row, col);
  cell.border = thinBorder();
  // light yellow to indicate "fill this"
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFEF0' } };
}

function colToLetter(col: number): string {
  let letter = '';
  let c = col;
  while (c > 0) {
    const rem = (c - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    c = Math.floor((c - 1) / 26);
  }
  return letter;
}

export async function generateBlankTemplate(): Promise<{ buffer: Buffer; fileName: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OBE Evaluation System';
  wb.created = new Date();

  const ws = wb.addWorksheet(SHEET, {
    views: [{ state: 'frozen', ySplit: ROW_STUDENT_HEADER }],
  });

  // ---- Column widths --------------------------------------------------
  ws.columns = [
    { width: 6 },   // A: SL / Q No
    { width: 18 },  // B: Student ID / Max Marks
    { width: 28 },  // C: Student Name / CO
    { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 },
    { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 },
    { width: 10 },  // N: Total
  ];

  // ---- Block 1: Course / Assessment header ----------------------------
  ws.mergeCells(ROW_TITLE, 1, ROW_TITLE, COL_TOTAL);
  const titleCell = ws.getCell(ROW_TITLE, 1);
  titleCell.value = 'OBE GRADING TEMPLATE — University of Chittagong';
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center' };
  ws.getRow(ROW_TITLE).height = 24;

  // Row 3: Department (label A, input B-D merged)
  labelCell(ws, ROW_DEPT, 1, 'Department:');
  ws.mergeCells(ROW_DEPT, 2, ROW_DEPT, 6);
  inputCell(ws, ROW_DEPT, 2);

  // Row 4: Program
  labelCell(ws, ROW_PROGRAM, 1, 'Program:');
  ws.mergeCells(ROW_PROGRAM, 2, ROW_PROGRAM, 6);
  inputCell(ws, ROW_PROGRAM, 2);

  // Row 5: Course Code | Course Title
  labelCell(ws, ROW_COURSE, 1, 'Course Code:');
  inputCell(ws, ROW_COURSE, 2);
  labelCell(ws, ROW_COURSE, 4, 'Course Title:');
  ws.mergeCells(ROW_COURSE, 5, ROW_COURSE, 8);
  inputCell(ws, ROW_COURSE, 5);

  // Row 6: Semester | Exam Date
  labelCell(ws, ROW_SEMESTER, 1, 'Semester:');
  inputCell(ws, ROW_SEMESTER, 2);
  labelCell(ws, ROW_SEMESTER, 4, 'Exam Date:');
  ws.mergeCells(ROW_SEMESTER, 5, ROW_SEMESTER, 6);
  inputCell(ws, ROW_SEMESTER, 5);

  // Row 7: Assessment Title | Type | Total Marks
  labelCell(ws, ROW_ASSESSMENT, 1, 'Assessment:');
  ws.mergeCells(ROW_ASSESSMENT, 2, ROW_ASSESSMENT, 4);
  inputCell(ws, ROW_ASSESSMENT, 2);
  labelCell(ws, ROW_ASSESSMENT, 5, 'Type:');
  inputCell(ws, ROW_ASSESSMENT, 6);
  labelCell(ws, ROW_ASSESSMENT, 7, 'Total Marks:');
  inputCell(ws, ROW_ASSESSMENT, 8);

  // ---- Block 2: Question definitions ---------------------------------
  ws.getCell(ROW_Q_HEADER - 1, 1).value = 'Question Definitions (fill Max Marks; CO is optional — leave blank for auto-assign)';
  ws.getCell(ROW_Q_HEADER - 1, 1).font = { bold: true, size: 11 };

  // Header row
  labelCell(ws, ROW_Q_HEADER, COL_Q_NO, 'Q No');
  labelCell(ws, ROW_Q_HEADER, COL_Q_MAX, 'Max Marks');
  labelCell(ws, ROW_Q_HEADER, COL_Q_CO, 'CO (optional)');

  // Q1..Q10 rows
  for (let i = 0; i < Q_COUNT; i++) {
    const r = ROW_Q_FIRST + i;
    ws.getCell(r, COL_Q_NO).value = i + 1;
    ws.getCell(r, COL_Q_NO).border = thinBorder();
    ws.getCell(r, COL_Q_NO).alignment = { horizontal: 'center' };
    inputCell(ws, r, COL_Q_MAX);
    inputCell(ws, r, COL_Q_CO);
  }

  // Data validation: max marks 0..100
  (ws as unknown as { dataValidations: { add: (r: string, v: unknown) => void } }).dataValidations.add(
    `${colToLetter(COL_Q_MAX)}${ROW_Q_FIRST}:${colToLetter(COL_Q_MAX)}${ROW_Q_LAST}`,
    {
      type: 'decimal', operator: 'between', formulae: [0, 100],
      allowBlank: true, showErrorMessage: true, errorStyle: 'error',
      error: 'Max marks must be between 0 and 100.', errorTitle: 'Invalid',
    }
  );

  // ---- Block 3: Student marks ----------------------------------------
  ws.getCell(ROW_STUDENT_HEADER - 1, 1).value = 'Student Marks (enter Student ID, Name, and marks for each question)';
  ws.getCell(ROW_STUDENT_HEADER - 1, 1).font = { bold: true, size: 11 };

  // Header row
  labelCell(ws, ROW_STUDENT_HEADER, COL_SL, 'SL');
  labelCell(ws, ROW_STUDENT_HEADER, COL_ROLL, 'Student ID');
  labelCell(ws, ROW_STUDENT_HEADER, COL_NAME, 'Student Name');
  for (let i = 0; i < Q_COUNT; i++) {
    labelCell(ws, ROW_STUDENT_HEADER, COL_Q_FIRST + i, `Q${i + 1}`);
  }
  labelCell(ws, ROW_STUDENT_HEADER, COL_TOTAL, 'Total');

  // Student rows
  for (let i = 0; i < STUDENT_COUNT; i++) {
    const r = ROW_STUDENT_FIRST + i;
    ws.getCell(r, COL_SL).value = i + 1;
    ws.getCell(r, COL_SL).border = thinBorder();
    ws.getCell(r, COL_SL).alignment = { horizontal: 'center' };
    inputCell(ws, r, COL_ROLL);
    inputCell(ws, r, COL_NAME);
    for (let q = 0; q < Q_COUNT; q++) {
      inputCell(ws, r, COL_Q_FIRST + q);
    }
    // Total = SUM of Q columns (formula)
    const firstCol = colToLetter(COL_Q_FIRST);
    const lastCol = colToLetter(COL_Q_FIRST + Q_COUNT - 1);
    const totalCell = ws.getCell(r, COL_TOTAL);
    totalCell.value = { formula: `SUM(${firstCol}${r}:${lastCol}${r})` };
    totalCell.border = thinBorder();
    totalCell.font = { bold: true };
    totalCell.alignment = { horizontal: 'center' };
  }

  // Data validation: student marks 0..100 (strict per-question max enforced on upload)
  const dvWs = ws as unknown as { dataValidations: { add: (r: string, v: unknown) => void } };
  for (let q = 0; q < Q_COUNT; q++) {
    const col = colToLetter(COL_Q_FIRST + q);
    dvWs.dataValidations.add(
      `${col}${ROW_STUDENT_FIRST}:${col}${ROW_STUDENT_FIRST + STUDENT_COUNT - 1}`,
      {
        type: 'decimal', operator: 'between', formulae: [0, 100],
        allowBlank: true, showErrorMessage: true, errorStyle: 'error',
        error: 'Marks must be between 0 and 100.', errorTitle: 'Invalid',
      }
    );
  }

  // ---- Instructions sheet ---------------------------------------------
  const instr = wb.addWorksheet('Instructions', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  instr.columns = [
    { width: 4 },   // #
    { width: 50 },  // Step
    { width: 60 },  // Details
  ];
  instr.getCell(1, 1).value = 'How to fill this template';
  instr.getCell(1, 1).font = { bold: true, size: 14 };
  instr.mergeCells(1, 1, 1, 3);

  const steps: [string, string, string][] = [
    ['1', 'Fill the header block (rows 3-7)', 'Department, Program, Course Code, Course Title, Semester (e.g. 2024-1/2), Exam Date, Assessment Title, Type (lowercase: quiz, midterm, final, assignment, lab, or project), Total Marks.'],
    ['2', 'Define questions (rows 11-20)', 'For each question you want to grade, enter its Max Marks (1-100). Leave blank rows for unused questions. The CO column is optional — leave it blank to auto-assign Q1→CO1, Q2→CO2, etc. To map a question to a specific CO, type the CO code (e.g. CO2).'],
    ['3', 'Enter student marks (rows 24+)', 'For each student, enter their Student ID, Name, and marks for each question. Leave a mark blank if the student did not attempt that question (counts as not attained). The Total column auto-calculates.'],
    ['4', 'Save the file', 'Save as .xlsx. Do not rename the "Grading" sheet or change the row layout — the software reads fixed cell positions.'],
    ['5', 'Upload', 'Upload the saved file in the OBE Evaluation System. The software validates every cell and reports any errors (e.g. "Row 25, Q2: Score 16 exceeds max marks 15"). Fix any errors and re-upload.'],
  ];
  steps.forEach(([num, step, details], i) => {
    const r = i + 3;
    instr.getCell(r, 1).value = num;
    instr.getCell(r, 1).font = { bold: true };
    instr.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'top' };
    instr.getCell(r, 2).value = step;
    instr.getCell(r, 2).font = { bold: true };
    instr.getCell(r, 2).alignment = { vertical: 'top' };
    instr.getCell(r, 3).value = details;
    instr.getCell(r, 3).alignment = { vertical: 'top', wrapText: true };
    instr.getRow(r).height = 48;
  });

  // Notes section
  const notesRow = steps.length + 5;
  instr.getCell(notesRow, 1).value = 'Notes';
  instr.getCell(notesRow, 1).font = { bold: true, size: 12 };
  instr.mergeCells(notesRow, 1, notesRow, 3);
  const notes: string[] = [
    '• Semester is required — students are enrolled per semester.',
    '• Assessment Type must be lowercase: quiz, midterm, final, assignment, lab, or project.',
    '• At least one question with max marks > 0 must be defined.',
    '• At least one student with a Student ID must be entered.',
    '• Each Student ID must be unique — duplicates will be rejected.',
    '• Marks cannot exceed the question max marks or be negative.',
    '• Up to 60 students and 10 questions are supported per template.',
    '• Re-uploading into a moderated/verified/published sheet is blocked. Roll back to "submitted" first.',
  ];
  notes.forEach((n, i) => {
    const r = notesRow + 1 + i;
    instr.getCell(r, 1).value = '';
    instr.getCell(r, 2).value = n;
    instr.mergeCells(r, 2, r, 3);
    instr.getCell(r, 2).alignment = { vertical: 'top' };
  });

  // ---- Hidden meta sheet ---------------------------------------------
  const meta = wb.addWorksheet(META);
  meta.state = 'hidden';
  const layout: Record<string, number> = {
    ROW_TITLE, ROW_DEPT, ROW_PROGRAM, ROW_COURSE, ROW_SEMESTER, ROW_ASSESSMENT,
    ROW_Q_HEADER, ROW_Q_FIRST, ROW_Q_LAST, Q_COUNT,
    ROW_STUDENT_HEADER, ROW_STUDENT_FIRST, STUDENT_COUNT,
    COL_SL, COL_ROLL, COL_NAME, COL_Q_FIRST, COL_TOTAL,
    COL_Q_NO, COL_Q_MAX, COL_Q_CO,
  };
  for (const [k, v] of Object.entries(layout)) {
    meta.addRow([k, v]);
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: 'OBE_Blank_Grading_Template.xlsx' };
}

// Re-export layout constants for the parser
export const LAYOUT = {
  ROW_TITLE, ROW_DEPT, ROW_PROGRAM, ROW_COURSE, ROW_SEMESTER, ROW_ASSESSMENT,
  ROW_Q_HEADER, ROW_Q_FIRST, ROW_Q_LAST, Q_COUNT,
  ROW_STUDENT_HEADER, ROW_STUDENT_FIRST, STUDENT_COUNT,
  COL_SL, COL_ROLL, COL_NAME, COL_Q_FIRST, COL_TOTAL,
  COL_Q_NO, COL_Q_MAX, COL_Q_CO,
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
