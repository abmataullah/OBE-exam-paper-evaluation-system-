-- ============================================================================
-- PHASE 1: DATABASE SCHEMA
-- Hybrid Outcome-Based Education (OBE) Management System
-- Target: PostgreSQL 13+
-- Reference structure: University of Chittagong (Department / Program / Course)
--
-- Run order: 1) this file (schema.sql)  2) seed.sql (optional demo data)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------

-- Bloom's Taxonomy cognitive levels (revised). Stored as an enum so the
-- database itself enforces valid values for every question.
CREATE TYPE blooms_level_enum AS ENUM (
  'remember',    -- L1
  'understand',  -- L2
  'apply',       -- L3
  'analyze',     -- L4
  'evaluate',    -- L5
  'create'       -- L6
);

-- Approval workflow for a grading sheet / assessment. The state machine is:
--   Draft -> Submitted -> Moderated -> Verified -> Published
-- (any forward transition is allowed; backward transitions require role
--  privileges and are enforced in the service layer, not the DB.)
CREATE TYPE assessment_status_enum AS ENUM (
  'draft',
  'submitted',
  'moderated',
  'verified',
  'published'
);

-- Assessment categories. Kept as an enum because the set is small and stable.
CREATE TYPE assessment_type_enum AS ENUM (
  'quiz',
  'midterm',
  'assignment',
  'lab',
  'final',
  'project'
);

-- Correlation weight for CO -> PO mapping:
--   1 = slight (low), 2 = moderate (medium), 3 = substantial (high)
-- Constrained to {1,2,3} via a CHECK in addition to the column type.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- ORGANISATIONAL HIERARCHY
-- ============================================================================

-- Departments (e.g. "Department of Computer Science & Engineering")
CREATE TABLE departments (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(200) NOT NULL UNIQUE,
  code         VARCHAR(20)  NOT NULL UNIQUE,
  faculty      VARCHAR(200),          -- e.g. "Faculty of Science"
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Programs (e.g. "B.Sc. in Computer Science & Engineering")
CREATE TABLE programs (
  id           SERIAL PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  code         VARCHAR(30)  NOT NULL,         -- e.g. "BSC-CSE"
  duration_years NUMERIC(2,1) NOT NULL DEFAULT 4.0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (department_id, code)
);

-- Program Outcomes (POs). Typically 12 (Washington Accord style) but the
-- count is not hard-coded so departments can define their own set.
CREATE TABLE program_outcomes (
  id           SERIAL PRIMARY KEY,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  po_code      VARCHAR(10)  NOT NULL,         -- e.g. "PO1", "PO12"
  description  TEXT         NOT NULL,
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (program_id, po_code)
);

CREATE INDEX idx_program_outcomes_program ON program_outcomes(program_id);


-- ============================================================================
-- COURSES & COURSE OUTCOMES
-- ============================================================================

-- Courses belong to a program (a course may be shared across programs via a
-- separate offering table in a larger system; here we keep 1:M program->course
-- for simplicity, which matches the Phase 1 requirement).
CREATE TABLE courses (
  id           SERIAL PRIMARY KEY,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  course_code  VARCHAR(20)  NOT NULL,         -- e.g. "CSE 401"
  title        VARCHAR(200) NOT NULL,
  credit_hours NUMERIC(3,1) NOT NULL DEFAULT 3.0,
  semester     VARCHAR(20),                   -- e.g. "2024-1/2" (year-term)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, course_code, semester)
);

-- Course Outcomes (COs). Numbered per course (CO1..COn).
CREATE TABLE course_outcomes (
  id           SERIAL PRIMARY KEY,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  co_code      VARCHAR(10)  NOT NULL,         -- e.g. "CO1"
  description  TEXT         NOT NULL,
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (course_id, co_code)
);

CREATE INDEX idx_course_outcomes_course ON course_outcomes(course_id);


-- ============================================================================
-- CO <-> PO MAPPING (junction)
-- ============================================================================

-- Each CO contributes to one or more POs with a correlation weight of 1/2/3.
-- The (course_outcome_id, program_outcome_id) pair is unique.
CREATE TABLE co_po_mapping (
  id                    SERIAL PRIMARY KEY,
  course_outcome_id     INTEGER NOT NULL REFERENCES course_outcomes(id) ON DELETE CASCADE,
  program_outcome_id    INTEGER NOT NULL REFERENCES program_outcomes(id) ON DELETE CASCADE,
  correlation_weight    SMALLINT NOT NULL
    CHECK (correlation_weight IN (1, 2, 3)),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_outcome_id, program_outcome_id)
);

CREATE INDEX idx_co_po_mapping_co ON co_po_mapping(course_outcome_id);
CREATE INDEX idx_co_po_mapping_po ON co_po_mapping(program_outcome_id);


-- ============================================================================
-- ASSESSMENTS, QUESTIONS, ENROLMENT
-- ============================================================================

-- Assessments for a course in a given semester (Midterm, Final, Quiz, ...).
CREATE TABLE assessments (
  id            SERIAL PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title         VARCHAR(120) NOT NULL,        -- e.g. "Midterm Examination"
  type          assessment_type_enum NOT NULL,
  total_marks   NUMERIC(6,2) NOT NULL CHECK (total_marks > 0),
  weight_in_course NUMERIC(5,2) NOT NULL DEFAULT 0.0
    CHECK (weight_in_course >= 0 AND weight_in_course <= 100), -- % of course grade
  exam_date     DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, title, exam_date)
);

-- A "grading sheet" is the unit that carries the approval workflow status.
-- It groups an assessment + its questions + the entered marks. We attach the
-- status here (per the Phase 1 requirement) so the whole sheet moves through
-- Draft -> Submitted -> Moderated -> Verified -> Published as one object.
CREATE TABLE grading_sheets (
  id            SERIAL PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  status        assessment_status_enum NOT NULL DEFAULT 'draft',
  -- Who last touched the sheet at each stage (nullable until that stage runs).
  prepared_by   VARCHAR(100),
  moderated_by  VARCHAR(100),
  verified_by   VARCHAR(100),
  published_by  VARCHAR(100),
  submitted_at  TIMESTAMPTZ,
  moderated_at  TIMESTAMPTZ,
  verified_at   TIMESTAMPTZ,
  published_at  TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id) -- one active sheet per assessment
);

CREATE INDEX idx_grading_sheets_status ON grading_sheets(status);

-- Questions for an assessment. Each question is tied to exactly one CO and
-- carries a Bloom's level. max_marks drives Excel data validation + upload
-- validation (Phase 2 / Phase 3).
CREATE TABLE questions (
  id            SERIAL PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_no   INTEGER NOT NULL,             -- 1-based ordering within assessment
  title         VARCHAR(300),                 -- optional short text
  co_id         INTEGER NOT NULL REFERENCES course_outcomes(id) ON DELETE RESTRICT,
  blooms_level  blooms_level_enum NOT NULL,
  max_marks     NUMERIC(6,2) NOT NULL CHECK (max_marks > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, question_no)
);

CREATE INDEX idx_questions_assessment ON questions(assessment_id);
CREATE INDEX idx_questions_co ON questions(co_id);


-- ============================================================================
-- STUDENTS & ENROLMENT
-- ============================================================================

-- Students. A student belongs to a program (cohort). university_roll is the
-- official registration number used on tabulation sheets.
CREATE TABLE students (
  id              SERIAL PRIMARY KEY,
  university_roll VARCHAR(30) NOT NULL UNIQUE,   -- official ID, e.g. "19301001"
  registration_no VARCHAR(30),                   -- optional internal reg no.
  name            VARCHAR(150) NOT NULL,
  program_id      INTEGER NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  session         VARCHAR(20),                   -- e.g. "2019-2020"
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_students_program ON students(program_id);

-- Enrolment: which students are taking a course in a given semester.
CREATE TABLE enrollments (
  id          SERIAL PRIMARY KEY,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  semester    VARCHAR(20) NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, student_id, semester)
);

CREATE INDEX idx_enrollments_course ON enrollments(course_id);
CREATE INDEX idx_enrollments_student ON enrollments(student_id);


-- ============================================================================
-- STUDENT MARKS (granular to the question level)
-- ============================================================================

-- Marks map to a specific question (NOT just the assessment), as required.
-- One row per (student, question). A partial unique index would be ideal but
-- we use a plain UNIQUE constraint: a re-grade replaces the row via upsert.
CREATE TABLE student_marks (
  id           SERIAL PRIMARY KEY,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  marks_obtained NUMERIC(6,2) NOT NULL,
  -- Enforce at the DB level too (belt + braces with the app-layer validation).
  -- We can't reference questions.max_marks in a CHECK directly, so this is a
  -- soft floor; the hard ceiling is enforced in the upload service + a trigger.
  CHECK (marks_obtained >= 0),
  graded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, student_id)
);

CREATE INDEX idx_student_marks_question ON student_marks(question_id);
CREATE INDEX idx_student_marks_student ON student_marks(student_id);

-- Trigger: hard-enforce marks_obtained <= questions.max_marks at the DB level,
-- so even direct SQL inserts cannot violate the constraint.
CREATE OR REPLACE FUNCTION enforce_marks_ceiling() RETURNS TRIGGER AS $$
DECLARE
  ceiling NUMERIC;
BEGIN
  SELECT max_marks INTO ceiling FROM questions WHERE id = NEW.question_id;
  IF ceiling IS NULL THEN
    RAISE EXCEPTION 'Question % does not exist', NEW.question_id;
  END IF;
  IF NEW.marks_obtained > ceiling THEN
    RAISE EXCEPTION 'Marks % exceed max marks % for question %',
      NEW.marks_obtained, ceiling, NEW.question_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_student_marks_ceiling
  BEFORE INSERT OR UPDATE OF marks_obtained ON student_marks
  FOR EACH ROW EXECUTE FUNCTION enforce_marks_ceiling();


-- ============================================================================
-- CONVENIENCE VIEWS
-- ============================================================================

-- Flat view: every mark with its course/CO/PO context. Useful for dashboards
-- and for the attainment service to aggregate in pure SQL when desired.
CREATE OR REPLACE VIEW v_marks_detail AS
SELECT
  sm.id AS mark_id,
  sm.student_id,
  s.university_roll,
  s.name AS student_name,
  sm.question_id,
  q.question_no,
  q.max_marks,
  sm.marks_obtained,
  q.co_id,
  co.co_code,
  q.blooms_level,
  q.assessment_id,
  a.course_id,
  c.course_code,
  c.title AS course_title
FROM student_marks sm
JOIN students s        ON s.id = sm.student_id
JOIN questions q       ON q.id = sm.question_id
JOIN course_outcomes co ON co.id = q.co_id
JOIN assessments a     ON a.id = q.assessment_id
JOIN courses c         ON c.id = a.course_id;

COMMIT;
