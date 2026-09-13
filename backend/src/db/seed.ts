/**
 * Optional demo seed. Creates one department, program, 12 POs, one course,
 * 4 COs, a CO-PO map, one assessment (Midterm) with 4 questions, 5 students,
 * enrolments, and a draft grading sheet.
 *
 * Usage: npm run seed   (after npm run migrate)
 */
import { query, endPool } from './pool';

async function run(): Promise<void> {
  try {
    // One statement per call: PGlite's prepared-statement path rejects
    // multi-command strings.
    for (const t of [
      'student_marks', 'questions', 'grading_sheets', 'assessments',
      'co_po_mapping', 'course_outcomes', 'enrollments', 'courses',
      'program_outcomes', 'programs', 'students', 'departments',
    ]) {
      await query(`DELETE FROM ${t}`);
    }

    const dept = await query(
      `INSERT INTO departments(name, code, faculty)
       VALUES ($1,$2,$3) RETURNING id`,
      ['Department of Computer Science & Engineering', 'CSE', 'Faculty of Science']
    );
    const deptId = dept.rows[0].id;

    const prog = await query(
      `INSERT INTO programs(department_id, name, code, duration_years)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [deptId, 'B.Sc. in Computer Science & Engineering', 'BSC-CSE', 4.0]
    );
    const progId = prog.rows[0].id;

    // 12 Program Outcomes (Washington Accord style)
    const poText = [
      'Engineering knowledge',
      'Problem analysis',
      'Design/development of solutions',
      'Conduct investigations of complex problems',
      'Modern tool usage',
      'The engineer and society',
      'Environment and sustainability',
      'Ethics',
      'Individual and team work',
      'Communication',
      'Project management and finance',
      'Life-long learning',
    ];
    const poIds: number[] = [];
    for (let i = 0; i < poText.length; i++) {
      const r = await query(
        `INSERT INTO program_outcomes(program_id, po_code, description, display_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [progId, `PO${i + 1}`, poText[i], i + 1]
      );
      poIds.push(r.rows[0].id);
    }

    const course = await query(
      `INSERT INTO courses(program_id, course_code, title, credit_hours, semester)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [progId, 'CSE 401', 'Software Engineering', 3.0, '2024-1/2']
    );
    const courseId = course.rows[0].id;

    // 4 Course Outcomes
    const coText = [
      'Apply software engineering principles to design a system',
      'Analyze requirements and produce SRS documents',
      'Evaluate software architectures and design patterns',
      'Develop and test a software project using modern tools',
    ];
    const coIds: number[] = [];
    for (let i = 0; i < coText.length; i++) {
      const r = await query(
        `INSERT INTO course_outcomes(course_id, co_code, description, display_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [courseId, `CO${i + 1}`, coText[i], i + 1]
      );
      coIds.push(r.rows[0].id);
    }

    // CO -> PO mapping (weights 1-3)
    const map: [number, number, number][] = [
      [0, 0, 3], [0, 2, 2], // CO1 -> PO1(3), PO3(2)
      [1, 1, 3], [1, 3, 2], // CO2 -> PO2(3), PO4(2)
      [2, 2, 3], [2, 4, 2], // CO3 -> PO3(3), PO5(2)
      [3, 3, 3], [3, 5, 2], [3, 10, 2], // CO4 -> PO4(3), PO6(2), PO11(2)
    ];
    for (const [coIdx, poIdx, w] of map) {
      await query(
        `INSERT INTO co_po_mapping(course_outcome_id, program_outcome_id, correlation_weight)
         VALUES ($1,$2,$3)`,
        [coIds[coIdx], poIds[poIdx], w]
      );
    }

    // Assessment: Midterm
    const assess = await query(
      `INSERT INTO assessments(course_id, title, type, total_marks, weight_in_course, exam_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [courseId, 'Midterm Examination', 'midterm', 40, 20, '2024-08-15']
    );
    const assessId = assess.rows[0].id;

    await query(
      `INSERT INTO grading_sheets(assessment_id, status) VALUES ($1,'draft')`,
      [assessId]
    );

    // 4 questions: Q1 CO1 10m, Q2 CO2 15m, Q3 CO3 8m, Q4 CO4 7m
    const qDefs: [number, string, number, number][] = [
      [1, 'remember', coIds[0], 10],
      [2, 'understand', coIds[1], 15],
      [3, 'analyze', coIds[2], 8],
      [4, 'apply', coIds[3], 7],
    ];
    for (const [qno, bloom, coId, max] of qDefs) {
      await query(
        `INSERT INTO questions(assessment_id, question_no, co_id, blooms_level, max_marks)
         VALUES ($1,$2,$3,$4,$5)`,
        [assessId, qno, coId, bloom, max]
      );
    }

    // 5 students + enrolments
    const names = ['Rahim Uddin', 'Karim Ahmed', 'Fatima Begum', 'Nadia Sultana', 'Imran Hossain'];
    for (let i = 0; i < names.length; i++) {
      const roll = `1930100${i + 1}`;
      const s = await query(
        `INSERT INTO students(university_roll, name, program_id, session)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [roll, names[i], progId, '2019-2020']
      );
      await query(
        `INSERT INTO enrollments(course_id, student_id, semester) VALUES ($1,$2,$3)`,
        [courseId, s.rows[0].id, '2024-1/2']
      );
    }

    // eslint-disable-next-line no-console
    console.log('[seed] Demo data inserted. course_id=%s assessment_id=%s', courseId, assessId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] Failed:', err);
    process.exitCode = 1;
  } finally {
    // Don't close PGlite when running inside the desktop app — the server
    // needs the connection to stay open. Only close when run as a standalone
    // script (npm run seed with PostgreSQL).
    if (process.env.DB_DRIVER !== 'pglite') {
      await endPool();
    }
  }
}

// Export for programmatic use (desktop app). Auto-run only when executed
// directly as the main script (npm run seed).
if (require.main === module) {
  run();
}

export { run as runSeed };
