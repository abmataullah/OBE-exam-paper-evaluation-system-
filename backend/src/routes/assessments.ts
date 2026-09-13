/**
 * Express routes for the OBE grading endpoints.
 *
 *   GET  /api/health
 *   GET  /api/template                                              -> blank .xlsx
 *   POST /api/process                                               -> upload filled .xlsx
 *   GET  /api/courses                                               -> list courses
 *   GET  /api/courses/:courseId/assessments                         -> list assessments
 *   GET  /api/courses/:courseId/assessments/:assessmentId/attainment -> JSON
 *   GET  /api/courses/:courseId/assessments/:assessmentId/tabulation -> PDF
 *   GET  /api/assessments/:assessmentId/sheet                        -> JSON (status)
 *   PATCH /api/assessments/:assessmentId/sheet                       -> JSON (workflow)
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { generateBlankTemplate, HttpError } from '../services/excelGenerator';
import { processFilledTemplate, getSheetStatus } from '../services/uploadParser';
import { calculateCourseAttainment } from '../services/attainment';
import { generateTabulationPdf, generateTabulationHtml } from '../services/pdfGenerator';
import { query } from '../db/pool';

export const router = Router();

// In-memory multer (we parse the buffer directly with exceljs).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx files are accepted.'));
    }
  },
});

// ---- error helper ---------------------------------------------------------
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  return 500;
}

// ---- routes ---------------------------------------------------------------

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * List all courses (with program + department info).
 */
router.get(
  '/courses',
  asyncHandler(async (_req, res) => {
    const r = await query(
      `SELECT c.id, c.course_code, c.title, c.semester,
              p.name AS program_name, d.name AS department_name
         FROM courses c
         JOIN programs p ON p.id = c.program_id
         JOIN departments d ON d.id = p.department_id
        ORDER BY c.course_code`
    );
    res.json(r.rows);
  })
);

/**
 * List assessments for a course.
 */
router.get(
  '/courses/:courseId/assessments',
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT id, course_id, title, type, total_marks, weight_in_course,
              exam_date::text AS exam_date
         FROM assessments WHERE course_id = $1 ORDER BY id`,
      [Number(req.params.courseId)]
    );
    res.json(r.rows);
  })
);

/**
 * Download the blank grading template (no course/assessment needed).
 */
router.get(
  '/template',
  asyncHandler(async (_req, res) => {
    const { buffer, fileName } = await generateBlankTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  })
);

/**
 * Upload a filled template — parse, validate, create all DB records.
 */
router.post(
  '/process',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        ok: false,
        errors: [{ row: 0, column: 'file', student_roll: '', message: 'No file uploaded.' }],
        courseId: null,
        assessmentId: null,
      });
      return;
    }
    const result = await processFilledTemplate(req.file.buffer);
    res.status(result.ok ? 200 : 422).json(result);
  })
);

/**
 * Phase 4: CO attainment report (JSON for the dashboard).
 */
router.get(
  '/courses/:courseId/assessments/:assessmentId/attainment',
  asyncHandler(async (req, res) => {
    const courseId = Number(req.params.courseId);
    const assessmentId = Number(req.params.assessmentId);
    const threshold = req.query.threshold ? Number(req.query.threshold) : undefined;
    const report = await calculateCourseAttainment({ courseId, assessmentId, threshold });
    res.json(report);
  })
);

/**
 * Phase 5: PDF tabulation sheet.
 */
router.get(
  '/courses/:courseId/assessments/:assessmentId/tabulation',
  asyncHandler(async (req, res) => {
    const courseId = Number(req.params.courseId);
    const assessmentId = Number(req.params.assessmentId);
    const opts = {
      courseId,
      assessmentId,
      preparedBy: (req.query.preparedBy as string) || undefined,
      moderatorBy: (req.query.moderatorBy as string) || undefined,
      chairmanBy: (req.query.chairmanBy as string) || undefined,
      threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
    };
    // ?format=html returns the print-ready HTML (preview; no Chrome needed).
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(await generateTabulationHtml(opts));
      return;
    }
    const { buffer, fileName } = await generateTabulationPdf(opts);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  })
);

/**
 * Grading-sheet status (approval workflow).
 */
router.get(
  '/assessments/:assessmentId/sheet',
  asyncHandler(async (req, res) => {
    const sheet = await getSheetStatus(Number(req.params.assessmentId));
    if (!sheet) {
      res.status(404).json({ error: 'No grading sheet for this assessment.' });
      return;
    }
    res.json(sheet);
  })
);

/**
 * Advance the approval workflow. Body: { status: 'submitted'|'moderated'|'verified'|'published', actor: 'Name' }
 */
const VALID_NEXT: Record<string, string[]> = {
  draft: ['submitted'],
  submitted: ['moderated', 'draft'],
  moderated: ['verified', 'submitted'],
  verified: ['published', 'moderated'],
  published: [],
};

router.patch(
  '/assessments/:assessmentId/sheet',
  asyncHandler(async (req, res) => {
    const assessmentId = Number(req.params.assessmentId);
    const next = String(req.body?.status ?? '').toLowerCase();
    const actor = String(req.body?.actor ?? '').trim();

    const sheet = await getSheetStatus(assessmentId);
    if (!sheet) {
      res.status(404).json({ error: 'No grading sheet for this assessment.' });
      return;
    }
    const current = sheet.status as string;
    const allowed = VALID_NEXT[current] ?? [];
    if (!allowed.includes(next)) {
      res.status(409).json({
        error: `Cannot transition from "${current}" to "${next}". Allowed: [${allowed.join(', ')}].`,
      });
      return;
    }

    const stampCol =
      next === 'submitted' ? 'submitted_at' :
      next === 'moderated' ? 'moderated_at' :
      next === 'verified' ? 'verified_at' :
      next === 'published' ? 'published_at' : null;

    const byCol =
      next === 'submitted' ? 'prepared_by' :
      next === 'moderated' ? 'moderated_by' :
      next === 'verified' ? 'verified_by' :
      next === 'published' ? 'published_by' : null;

    // Build SET clauses + params with stable $N placeholders.
    const sets: string[] = [`status = $1`, `updated_at = now()`];
    const params: unknown[] = [next];
    if (stampCol) sets.push(`${stampCol} = now()`);
    if (byCol && actor) {
      params.push(actor);
      sets.push(`${byCol} = $${params.length}`);
    }
    params.push(assessmentId);
    await query(
      `UPDATE grading_sheets SET ${sets.join(', ')} WHERE assessment_id = $${params.length}`,
      params
    );

    res.json({ ok: true, assessmentId, previous: current, next });
  })
);

/**
 * Delete an assessment (and all its questions/marks/sheet via CASCADE).
 * Blocked if the sheet is moderated/verified/published — roll back first.
 */
router.delete(
  '/assessments/:assessmentId',
  asyncHandler(async (req, res) => {
    const assessmentId = Number(req.params.assessmentId);
    const sheet = await getSheetStatus(assessmentId);
    if (sheet && (sheet.status === 'moderated' || sheet.status === 'verified' || sheet.status === 'published')) {
      res.status(409).json({
        error: `Cannot delete: assessment is "${sheet.status}". Roll back to "submitted" or "draft" first.`,
      });
      return;
    }
    const r = await query(`DELETE FROM assessments WHERE id = $1 RETURNING id`, [assessmentId]);
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'Assessment not found.' });
      return;
    }
    res.json({ ok: true, assessmentId });
  })
);

// ---- error handler (last) -------------------------------------------------
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = errorStatus(err);
  let message = err instanceof Error ? err.message : 'Internal server error';

  // Map multer errors to sensible status codes.
  if (err instanceof Error && 'code' in err) {
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') { status = 413; message = 'File too large (max 5 MB).'; }
    else if (code === 'LIMIT_UNEXPECTED_FILE') { status = 400; }
    else if (status === 500) status = 400; // filter rejection etc.
  }

  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[api] 500:', err);
  }
  res.status(status).json({ ok: false, error: message });
});
