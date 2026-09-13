// Frontend types mirroring the backend domain models.

export interface Course {
  id: number;
  course_code: string;
  title: string;
  semester: string | null;
  program_name?: string;
  department_name?: string;
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

export interface MarkValidationError {
  row: number;
  column: string;
  student_roll: string;
  message: string;
}

export interface UploadResult {
  ok: boolean;
  errors: MarkValidationError[];
  appliedCount: number;
  assessmentId: number;
}

export interface COAttainment {
  co_id: number;
  co_code: string;
  co_description: string;
  total_students: number;
  students_attained: number;
  attainment_percentage: number;
  met_threshold: boolean;
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

export interface GradingSheet {
  id: number;
  assessment_id: number;
  status: 'draft' | 'submitted' | 'moderated' | 'verified' | 'published';
  prepared_by: string | null;
  moderated_by: string | null;
  verified_by: string | null;
  published_by: string | null;
  submitted_at: string | null;
  moderated_at: string | null;
  verified_at: string | null;
  published_at: string | null;
  notes: string | null;
  updated_at: string;
}
