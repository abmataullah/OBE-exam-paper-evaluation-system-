/**
 * Shared domain types used across services.
 */

export interface ProgramOutcome {
  id: number;
  po_code: string;
  description: string;
}

export interface CourseOutcome {
  id: number;
  co_code: string;
  description: string;
}

export interface Question {
  id: number;
  assessment_id: number;
  question_no: number;
  title: string | null;
  co_id: number;
  co_code: string;
  blooms_level: string;
  max_marks: number;
}

export interface EnrolledStudent {
  student_id: number;
  university_roll: string;
  name: string;
}

export interface Assessment {
  id: number;
  course_id: number;
  title: string;
  type: string;
  total_marks: number;
  weight_in_course: number;
  exam_date: string | null;
}

export interface Course {
  id: number;
  course_code: string;
  title: string;
  semester: string | null;
}

/** A single validation error from the Excel upload (Phase 3). */
export interface MarkValidationError {
  row: number;            // 1-based Excel data row (excluding header)
  column: string;         // e.g. "Q2"
  student_roll: string;   // the roll on that row (may be empty if missing)
  message: string;        // human-readable reason
}

/** Result of parsing + validating an uploaded grading sheet. */
export interface UploadValidationResult {
  ok: boolean;
  errors: MarkValidationError[];
  appliedCount: number;   // number of mark rows written (0 if ok=false)
  assessmentId: number;
}

/** CO attainment result for one CO (Phase 4). */
export interface COAttainment {
  co_id: number;
  co_code: string;
  co_description: string;
  total_students: number;
  students_attained: number;
  attainment_percentage: number; // 0-100
  met_threshold: boolean;        // >= 60% (configurable)
  per_question: {
    question_id: number;
    question_no: number;
    max_marks: number;
    attained: number;
    total: number;
    percentage: number;
  }[];
}

export interface CourseAttainmentReport {
  course_id: number;
  course_code: string;
  course_title: string;
  assessment_id: number;
  assessment_title: string;
  threshold: number;
  co_attainments: COAttainment[];
}
