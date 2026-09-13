/**
 * PHASE 4: ATTAINMENT CALCULATION LOGIC
 * -------------------------------------
 * Calculates Course Outcome (CO) attainment for a specific course /
 * assessment using a threshold-based (direct) method:
 *
 *   For every student, compute the percentage score on each question.
 *   A student is counted as having "attained" a CO if they scored >= the
 *   threshold (default 60%) on EVERY question mapped to that CO within the
 *   assessment. The CO attainment percentage is then:
 *
 *       attainment% = (students who attained CO / total enrolled students) * 100
 *
 *   A CO is considered "met" overall when attainment% >= the threshold.
 *
 * The function also returns per-question breakdowns so the dashboard can show
 * which question is dragging a CO down.
 *
 * Notes on design:
 *  - "Total students" is the enrolled count for the course, NOT the count of
 *    students who have marks. A student with no marks counts as not attained,
 *    which correctly penalises incomplete grading.
 *  - The threshold is configurable via ATTAINMENT_THRESHOLD env (0-100).
 */
import { query } from '../db/pool';
import type { COAttainment, CourseAttainmentReport } from '../types';

export interface AttainmentInput {
  courseId: number;
  assessmentId: number;
  /** Override the env threshold (0-100). */
  threshold?: number;
}

function getThreshold(): number {
  const t = Number(process.env.ATTAINMENT_THRESHOLD ?? 60);
  if (!Number.isFinite(t) || t < 0 || t > 100) return 60;
  return t;
}

interface QuestionRow {
  question_id: number;
  question_no: number;
  co_id: number;
  co_code: string;
  co_description: string;
  max_marks: number;
  student_id: number;
  marks_obtained: number | null;
}

interface CourseInfo {
  course_code: string;
  course_title: string;
  assessment_title: string;
  total_enrolled: number;
}

/**
 * Calculate CO attainment for one assessment within a course.
 */
export async function calculateCourseAttainment(
  input: AttainmentInput
): Promise<CourseAttainmentReport> {
  const threshold = input.threshold ?? getThreshold();

  // 1. Course + assessment + enrolled count
  const infoRows = await query<CourseInfo & { total_enrolled: string }>(
    `SELECT c.course_code, c.title AS course_title,
            a.title AS assessment_title,
            (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id)::text AS total_enrolled
       FROM courses c
       JOIN assessments a ON a.course_id = c.id
      WHERE c.id = $1 AND a.id = $2`,
    [input.courseId, input.assessmentId]
  );
  if (infoRows.rowCount === 0) {
    throw new Error(`Course ${input.courseId} / assessment ${input.assessmentId} not found`);
  }
  const info = infoRows.rows[0];
  const totalEnrolled = Number(info.total_enrolled);

  // 2. Pull every (question, student, marks) row for this assessment, joined
  //    with the CO and the enrolled student set. We LEFT JOIN student_marks so
  //    that students with no marks yet still appear (marks_obtained = NULL).
  const rows = await query<QuestionRow>(
    `SELECT q.id AS question_id, q.question_no, q.co_id,
            co.co_code, co.description AS co_description,
            q.max_marks::float8 AS max_marks,
            s.id AS student_id,
            sm.marks_obtained::float8 AS marks_obtained
       FROM questions q
       JOIN course_outcomes co ON co.id = q.co_id
       JOIN assessments a ON a.id = q.assessment_id
       JOIN courses c ON c.id = a.course_id
       JOIN enrollments e ON e.course_id = c.id
       JOIN students s ON s.id = e.student_id
  LEFT JOIN student_marks sm ON sm.question_id = q.id AND sm.student_id = s.id
      WHERE a.id = $1
      ORDER BY q.co_id, q.question_no, s.id`,
    [input.assessmentId]
  );

  // 3. Group by CO -> question -> student marks
  //    coMap: coId -> { meta, questions: questionId -> { meta, students: studentId -> pct|null } }
  const coMap = new Map<
    number,
    {
      co_code: string;
      co_description: string;
      questions: Map<
        number,
        {
          question_no: number;
          max_marks: number;
          students: Map<number, number | null>; // studentId -> pct (0-100) or null
        }
      >;
    }
  >();

  for (const r of rows.rows) {
    let co = coMap.get(r.co_id);
    if (!co) {
      co = { co_code: r.co_code, co_description: r.co_description, questions: new Map() };
      coMap.set(r.co_id, co);
    }
    let q = co.questions.get(r.question_id);
    if (!q) {
      q = { question_no: r.question_no, max_marks: r.max_marks, students: new Map() };
      co.questions.set(r.question_id, q);
    }
    const pct =
      r.marks_obtained == null || r.max_marks <= 0
        ? null
        : (r.marks_obtained / r.max_marks) * 100;
    q.students.set(r.student_id, pct);
  }

  // 4. The set of all students who took this course (denominator). We derive
  //    it from the rows above (every enrolled student appears once per
  //    question). Take the union of student ids across the first question of
  //    each CO — but to be safe, collect the global student set.
  const allStudents = new Set<number>();
  for (const co of coMap.values()) {
    for (const q of co.questions.values()) {
      for (const sid of q.students.keys()) allStudents.add(sid);
    }
  }
  const totalStudents = allStudents.size || totalEnrolled;

  // 5. For each CO: a student "attains" the CO iff they scored >= threshold on
  //    EVERY question mapped to that CO.
  const coAttainments: COAttainment[] = [];

  for (const [coId, co] of coMap) {
    let attainedCount = 0;
    const perQuestion: COAttainment['per_question'] = [];

    for (const [qId, q] of co.questions) {
      let qAttained = 0;
      let qGraded = 0;
      for (const pct of q.students.values()) {
        if (pct == null) continue; // not graded -> counts as not attained
        qGraded++;
        if (pct >= threshold) qAttained++;
      }
      const qTotal = q.students.size;
      perQuestion.push({
        question_id: qId,
        question_no: q.question_no,
        max_marks: q.max_marks,
        attained: qAttained,
        total: qTotal,
        percentage: qTotal > 0 ? (qAttained / qTotal) * 100 : 0,
      });
    }

    // Student-level CO attainment: must pass ALL questions of the CO.
    for (const sid of allStudents) {
      let passedAll = true;
      let anyGraded = false;
      for (const q of co.questions.values()) {
        const pct = q.students.get(sid) ?? null;
        if (pct == null) {
          passedAll = false; // ungraded question -> cannot attain
          break;
        }
        anyGraded = true;
        if (pct < threshold) {
          passedAll = false;
          break;
        }
      }
      if (passedAll && anyGraded) attainedCount++;
    }

    const attainmentPct =
      totalStudents > 0 ? (attainedCount / totalStudents) * 100 : 0;

    coAttainments.push({
      co_id: coId,
      co_code: co.co_code,
      co_description: co.co_description,
      total_students: totalStudents,
      students_attained: attainedCount,
      attainment_percentage: round1(attainmentPct),
      met_threshold: attainmentPct >= threshold,
      per_question: perQuestion.sort((a, b) => a.question_no - b.question_no),
    });
  }

  coAttainments.sort((a, b) => a.co_code.localeCompare(b.co_code, undefined, { numeric: true }));

  return {
    course_id: input.courseId,
    course_code: info.course_code,
    course_title: info.course_title,
    assessment_id: input.assessmentId,
    assessment_title: info.assessment_title,
    threshold,
    co_attainments: coAttainments,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
