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
  sigs?: { preparedBy?: string; moderatorBy?: string; chairmanBy?: string }
): Promise<Blob> {
  const params = new URLSearchParams();
  if (sigs?.preparedBy) params.set('preparedBy', sigs.preparedBy);
  if (sigs?.moderatorBy) params.set('moderatorBy', sigs.moderatorBy);
  if (sigs?.chairmanBy) params.set('chairmanBy', sigs.chairmanBy);
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
