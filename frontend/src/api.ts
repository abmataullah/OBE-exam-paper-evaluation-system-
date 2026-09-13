import type {
  Course,
  Assessment,
  MarkValidationError,
  CourseAttainmentReport,
  GradingSheet,
} from './types';

const BASE = '/api';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listCourses(): Promise<Course[]> {
  return json<Course[]>(await fetch(`${BASE}/courses`));
}

export async function listAssessments(courseId: number): Promise<Assessment[]> {
  return json<Assessment[]>(
    await fetch(`${BASE}/courses/${courseId}/assessments`)
  );
}

/** Download the blank grading template. */
export async function downloadBlankTemplate(): Promise<Blob> {
  const res = await fetch(`${BASE}/template`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export interface ProcessResult {
  ok: boolean;
  errors: MarkValidationError[];
  courseId: number | null;
  assessmentId: number | null;
}

/** Upload a filled template — creates all DB records.
 *  Returns the structured body even on 422 (validation errors) so the UI
 *  can display per-cell errors. Throws only on transport/500 errors. */
export async function processTemplate(file: File): Promise<ProcessResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/process`, { method: 'POST', body: form });
  // 422 is a structured validation error response, not a transport failure.
  if (res.status === 422) {
    return res.json() as Promise<ProcessResult>;
  }
  return json<ProcessResult>(res);
}

export async function getAttainment(
  courseId: number,
  assessmentId: number,
  threshold?: number
): Promise<CourseAttainmentReport> {
  const q = threshold ? `?threshold=${threshold}` : '';
  return json<CourseAttainmentReport>(
    await fetch(
      `${BASE}/courses/${courseId}/assessments/${assessmentId}/attainment${q}`
    )
  );
}

/** Download the PDF tabulation sheet. */
export async function downloadTabulation(
  courseId: number,
  assessmentId: number,
  sigs?: { preparedBy?: string; moderatorBy?: string; chairmanBy?: string; threshold?: number }
): Promise<Blob> {
  const params = new URLSearchParams();
  if (sigs?.preparedBy) params.set('preparedBy', sigs.preparedBy);
  if (sigs?.moderatorBy) params.set('moderatorBy', sigs.moderatorBy);
  if (sigs?.chairmanBy) params.set('chairmanBy', sigs.chairmanBy);
  if (sigs?.threshold != null) params.set('threshold', String(sigs.threshold));
  const q = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(
    `${BASE}/courses/${courseId}/assessments/${assessmentId}/tabulation${q}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export async function getSheetStatus(
  assessmentId: number
): Promise<GradingSheet | null> {
  const res = await fetch(`${BASE}/assessments/${assessmentId}/sheet`);
  if (res.status === 404) return null;
  return json<GradingSheet>(res);
}

/** Advance the grading-sheet approval workflow.
 *  status: 'submitted' | 'moderated' | 'verified' | 'published'
 *  actor:  name of the person performing the action */
export async function advanceSheet(
  assessmentId: number,
  status: 'submitted' | 'moderated' | 'verified' | 'published',
  actor: string
): Promise<{ ok: boolean; previous: string; next: string }> {
  const res = await fetch(`${BASE}/assessments/${assessmentId}/sheet`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, actor }),
  });
  return json(res);
}

/** Delete an assessment (and all its questions/marks/sheet).
 *  Blocked if the sheet is moderated/verified/published. */
export async function deleteAssessment(assessmentId: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/assessments/${assessmentId}`, { method: 'DELETE' });
  return json(res);
}

/** Open the tabulation HTML preview in a new tab (no Chrome needed). */
export function previewTabulationHtml(
  courseId: number,
  assessmentId: number,
  sigs?: { preparedBy?: string; moderatorBy?: string; chairmanBy?: string; threshold?: number }
): void {
  const params = new URLSearchParams();
  if (sigs?.preparedBy) params.set('preparedBy', sigs.preparedBy);
  if (sigs?.moderatorBy) params.set('moderatorBy', sigs.moderatorBy);
  if (sigs?.chairmanBy) params.set('chairmanBy', sigs.chairmanBy);
  if (sigs?.threshold != null) params.set('threshold', String(sigs.threshold));
  params.set('format', 'html');
  window.open(`${BASE}/courses/${courseId}/assessments/${assessmentId}/tabulation?${params.toString()}`, '_blank');
}

/** Trigger a browser download from a Blob. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
