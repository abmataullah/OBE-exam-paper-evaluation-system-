/**
 * Test helper: fill the BLANK template the way a teacher would, so we can
 * exercise /api/process end to end.
 *
 * Usage: node dist/test/fillBlank.js <blank.xlsx> <out.xlsx> [--invalid]
 */
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync } from 'fs';
import { LAYOUT as L } from '../services/excelGenerator';

async function main(): Promise<void> {
  const [inPath, outPath, flag] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('Usage: node dist/test/fillBlank.js <blank.xlsx> <out.xlsx> [--invalid]');
    process.exit(1);
  }
  const invalid = flag === '--invalid';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(inPath) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Grading');
  if (!ws) throw new Error('No Grading sheet');

  // Header block
  ws.getCell(L.ROW_DEPT, 2).value = 'Department of Computer Science & Engineering';
  ws.getCell(L.ROW_PROGRAM, 2).value = 'B.Sc. in Computer Science & Engineering';
  ws.getCell(L.ROW_COURSE, 2).value = 'CSE 401';
  ws.getCell(L.ROW_COURSE, 5).value = 'Software Engineering';
  ws.getCell(L.ROW_SEMESTER, 2).value = '2024-1/2';
  ws.getCell(L.ROW_SEMESTER, 5).value = '2024-08-15';
  ws.getCell(L.ROW_ASSESSMENT, 2).value = 'Midterm Examination';
  ws.getCell(L.ROW_ASSESSMENT, 6).value = 'midterm';
  ws.getCell(L.ROW_ASSESSMENT, 8).value = 40;

  // Questions: Q1=10, Q2=15, Q3=8, Q4=7 (CO left blank -> auto)
  const maxes = [10, 15, 8, 7];
  maxes.forEach((m, i) => { ws.getCell(L.ROW_Q_FIRST + i, L.COL_Q_MAX).value = m; });

  // Students
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

  if (invalid) {
    // Row 2 student: Q2 = 16 (> 15); Row 4 student: Q4 = -1
    ws.getCell(L.ROW_STUDENT_FIRST + 1, L.COL_Q_FIRST + 1).value = 16;
    ws.getCell(L.ROW_STUDENT_FIRST + 3, L.COL_Q_FIRST + 3).value = -1;
  }

  writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));
  console.log(`Wrote ${outPath}${invalid ? ' (with deliberate errors)' : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
