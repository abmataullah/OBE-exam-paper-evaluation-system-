import { useState, useEffect, useCallback } from 'react';
import {
  listCourses,
  listAssessments,
  downloadBlankTemplate,
  processTemplate,
  saveBlob,
  getAttainment,
  downloadTabulation,
  getSheetStatus,
  advanceSheet,
  deleteAssessment,
  previewTabulationHtml,
  type ProcessResult,
} from './api';
import type {
  Course,
  Assessment,
  CourseAttainmentReport,
  GradingSheet,
  MarkValidationError,
} from './types';

const WORKFLOW_STEPS = ['draft', 'submitted', 'moderated', 'verified', 'published'] as const;
const NEXT_STATUS: Record<string, string> = {
  draft: 'submitted',
  submitted: 'moderated',
  moderated: 'verified',
  verified: 'published',
};
const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  moderated: 'Moderated',
  verified: 'Verified',
  published: 'Published',
};
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  submitted: 'bg-blue-100 text-blue-700',
  moderated: 'bg-amber-100 text-amber-700',
  verified: 'bg-purple-100 text-purple-700',
  published: 'bg-green-100 text-green-700',
};

export default function App() {
  // The uploaded result gives us courseId + assessmentId to view results
  const [processResult, setProcessResult] = useState<ProcessResult | null>(null);
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null);
  const [activeAssessmentId, setActiveAssessmentId] = useState<number | null>(null);

  // Browse existing results
  const [courses, setCourses] = useState<Course[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [browseCourseId, setBrowseCourseId] = useState<number | null>(null);

  // Result views
  const [attainment, setAttainment] = useState<CourseAttainmentReport | null>(null);
  const [attainmentLoading, setAttainmentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Threshold configuration (default 60%)
  const [threshold, setThreshold] = useState(60);

  // Tabulation signature fields
  const [preparedBy, setPreparedBy] = useState('');
  const [moderatorBy, setModeratorBy] = useState('');
  const [chairmanBy, setChairmanBy] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Approval workflow state
  const [sheet, setSheet] = useState<GradingSheet | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [workflowActor, setWorkflowActor] = useState('');

  function showSuccess(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 5000);
  }

  // Load courses on mount
  useEffect(() => {
    listCourses().then(setCourses).catch((e) => setError(e.message));
  }, []);

  // Load assessments when browsing
  useEffect(() => {
    if (browseCourseId == null) return;
    setAssessments([]);
    setActiveAssessmentId(null);
    listAssessments(browseCourseId).then(setAssessments).catch((e) => setError(e.message));
  }, [browseCourseId]);

  // Load attainment + sheet status when active course/assessment changes
  const loadAttainment = useCallback(async () => {
    if (activeCourseId == null || activeAssessmentId == null) return;
    setAttainmentLoading(true);
    setError(null);
    try {
      setAttainment(await getAttainment(activeCourseId, activeAssessmentId, threshold));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load attainment');
    } finally {
      setAttainmentLoading(false);
    }
  }, [activeCourseId, activeAssessmentId, threshold]);

  const loadSheet = useCallback(async () => {
    if (activeAssessmentId == null) return;
    setSheetLoading(true);
    try {
      setSheet(await getSheetStatus(activeAssessmentId));
    } catch {
      setSheet(null);
    } finally {
      setSheetLoading(false);
    }
  }, [activeAssessmentId]);

  useEffect(() => {
    loadAttainment();
    loadSheet();
  }, [loadAttainment, loadSheet]);

  // When upload succeeds, set active course/assessment
  useEffect(() => {
    if (processResult?.ok && processResult.courseId && processResult.assessmentId) {
      setActiveCourseId(processResult.courseId);
      setActiveAssessmentId(processResult.assessmentId);
      // Refresh course list
      listCourses().then(setCourses).catch(() => {});
    }
  }, [processResult]);

  async function handleDownloadTemplate() {
    try {
      const blob = await downloadBlankTemplate();
      saveBlob(blob, 'OBE_Blank_Grading_Template.xlsx');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    }
  }

  async function handleUpload() {
    if (!file) return;
    setUploadBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await processTemplate(file);
      setProcessResult(r);
      if (r.ok) {
        showSuccess('Records created successfully. Results are ready below.');
      } else {
        setError(`Validation failed — ${r.errors.length} error(s) found. Fix and re-upload.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleDownloadPdf() {
    if (activeCourseId == null || activeAssessmentId == null) return;
    setPdfBusy(true);
    setError(null);
    try {
      const blob = await downloadTabulation(activeCourseId, activeAssessmentId, {
        preparedBy: preparedBy || undefined,
        moderatorBy: moderatorBy || undefined,
        chairmanBy: chairmanBy || undefined,
        threshold,
      });
      saveBlob(blob, 'Tabulation_Sheet.pdf');
      showSuccess('Tabulation PDF downloaded.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PDF generation failed. Is Chrome/Edge installed?');
    } finally {
      setPdfBusy(false);
    }
  }

  async function handleAdvanceWorkflow() {
    if (activeAssessmentId == null || !sheet) return;
    const next = NEXT_STATUS[sheet.status];
    if (!next) return;
    const actor = workflowActor.trim() || 'Teacher';
    setError(null);
    try {
      await advanceSheet(activeAssessmentId, next as 'submitted' | 'moderated' | 'verified' | 'published', actor);
      showSuccess(`Sheet advanced to "${STATUS_LABELS[next]}".`);
      await loadSheet();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workflow update failed');
    }
  }

  async function handleDeleteAssessment() {
    if (activeAssessmentId == null) return;
    if (!confirm('Delete this assessment and all its marks? This cannot be undone.')) return;
    setError(null);
    try {
      await deleteAssessment(activeAssessmentId);
      setActiveAssessmentId(null);
      setActiveCourseId(null);
      setAttainment(null);
      setSheet(null);
      setProcessResult(null);
      listCourses().then(setCourses).catch(() => {});
      if (browseCourseId != null) {
        listAssessments(browseCourseId).then(setAssessments).catch(() => {});
      }
      showSuccess('Assessment deleted.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  function handlePreviewHtml() {
    if (activeCourseId == null || activeAssessmentId == null) return;
    previewTabulationHtml(activeCourseId, activeAssessmentId, {
      preparedBy: preparedBy || undefined,
      moderatorBy: moderatorBy || undefined,
      chairmanBy: chairmanBy || undefined,
      threshold,
    });
  }

  function handleExportAttainmentCsv() {
    if (!attainment || attainment.co_attainments.length === 0) return;
    const rows = [
      ['CO Code', 'Description', 'Total Students', 'Students Attained', 'Attainment %', 'Met Threshold'],
      ...attainment.co_attainments.map((co) => [
        co.co_code,
        co.co_description,
        String(co.total_students),
        String(co.students_attained),
        co.attainment_percentage.toFixed(1),
        co.met_threshold ? 'Yes' : 'No',
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    saveBlob(blob, `Attainment_${attainment.course_code}_${attainment.assessment_title}.csv`);
    showSuccess('Attainment CSV exported.');
  }

  const hardErrors = processResult?.errors ?? [];
  const activeAssessment = assessments.find((a) => a.id === activeAssessmentId);
  const overallAttainment = attainment && attainment.co_attainments.length > 0
    ? attainment.co_attainments.reduce((sum, co) => sum + co.attainment_percentage, 0) / attainment.co_attainments.length
    : null;
  const cosMet = attainment ? attainment.co_attainments.filter((co) => co.met_threshold).length : 0;

  return (
    <div className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <h1 className="text-xl font-bold text-slate-900">OBE Evaluation System</h1>
          <p className="text-sm text-slate-500">
            Outcome-Based Education · CO/PO Attainment · University of Chittagong
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {success}
          </div>
        )}

        {/* Step 1: Download Template */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-slate-900">Download Blank Template</h2>
              <p className="mb-3 text-sm text-slate-600">
                Download a blank Excel template. Fill in your course info, questions (with max marks), student list, and marks — all offline.
              </p>
              <button
                onClick={handleDownloadTemplate}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
              >
                Download Excel Template
              </button>
            </div>
          </div>
        </section>

        {/* Step 2: Upload Filled Template */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-slate-900">Upload Filled Template</h2>
              <p className="mb-3 text-sm text-slate-600">
                Upload the filled Excel file. The software validates everything, creates the records, and calculates attainment.
              </p>

              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
                }}
                className={`mb-3 cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
                  dragOver ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                <input
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  id="file-input"
                  onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])}
                />
                <label htmlFor="file-input" className="cursor-pointer">
                  {file ? (
                    <div>
                      <p className="font-medium text-slate-900">{file.name}</p>
                      <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
                    </div>
                  ) : (
                    <p className="text-slate-500">Drag & drop the filled .xlsx here, or click to browse</p>
                  )}
                </label>
              </div>

              <button
                onClick={handleUpload}
                disabled={!file || uploadBusy}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {uploadBusy ? 'Processing...' : 'Validate & Process'}
              </button>

              {/* Validation errors */}
              {processResult && !processResult.ok && hardErrors.length > 0 && (
                <div className="mt-4 overflow-hidden rounded-lg border border-red-200">
                  <table className="w-full text-sm">
                    <thead className="bg-red-50 text-left text-xs uppercase text-red-700">
                      <tr>
                        <th className="px-4 py-2">Row</th>
                        <th className="px-4 py-2">Column</th>
                        <th className="px-4 py-2">Student ID</th>
                        <th className="px-4 py-2">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100">
                      {hardErrors.map((e: MarkValidationError, i: number) => (
                        <tr key={i} className="text-red-700">
                          <td className="px-4 py-2 font-mono">{e.row}</td>
                          <td className="px-4 py-2 font-mono">{e.column}</td>
                          <td className="px-4 py-2 font-mono">{e.student_roll}</td>
                          <td className="px-4 py-2">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {processResult?.ok && (
                <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                  <p className="font-semibold">Success! Records created. Results are ready below.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Step 3: Attainment Results */}
        {activeCourseId != null && activeAssessmentId != null && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">3</div>
              <div className="flex-1">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-900">CO Attainment</h2>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-slate-600">
                      Threshold:
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={threshold}
                        onChange={(e) => setThreshold(Number(e.target.value) || 0)}
                        className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                      />
                      %
                    </label>
                    <button onClick={loadAttainment} className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                      Refresh
                    </button>
                  </div>
                </div>

                {attainmentLoading ? (
                  <p className="text-sm text-slate-500">Calculating...</p>
                ) : attainment ? (
                  <div className="space-y-4">
                    <p className="text-sm text-slate-500">
                      {attainment.course_code} — {attainment.course_title} · {attainment.assessment_title} · Threshold: {attainment.threshold}%
                    </p>

                    {/* Summary card */}
                    {overallAttainment != null && attainment.co_attainments.length > 0 && (
                      <div className="grid grid-cols-3 gap-3">
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
                          <p className="text-2xl font-bold text-slate-900">{overallAttainment.toFixed(1)}%</p>
                          <p className="text-xs text-slate-500">Overall Attainment</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
                          <p className="text-2xl font-bold text-slate-900">{cosMet}/{attainment.co_attainments.length}</p>
                          <p className="text-xs text-slate-500">COs Attained</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
                          <p className={`text-2xl font-bold ${cosMet === attainment.co_attainments.length ? 'text-green-600' : 'text-amber-600'}`}>
                            {cosMet === attainment.co_attainments.length ? 'PASS' : 'PARTIAL'}
                          </p>
                          <p className="text-xs text-slate-500">Course Status</p>
                        </div>
                      </div>
                    )}

                    {attainment.co_attainments.length === 0 ? (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                        No CO data. Ensure students are enrolled and marks are entered.
                      </p>
                    ) : (
                      <>
                        <div className="flex justify-end">
                          <button onClick={handleExportAttainmentCsv} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                            Export CSV
                          </button>
                        </div>
                        {attainment.co_attainments.map((co) => (
                          <div key={co.co_id} className="rounded-lg border border-slate-200 p-4">
                            <div className="mb-2 flex items-center justify-between">
                              <div>
                                <span className="font-mono font-semibold">{co.co_code}</span>
                                <span className="ml-2 text-sm text-slate-500">{co.co_description}</span>
                              </div>
                              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${co.met_threshold ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                {co.attainment_percentage.toFixed(1)}% · {co.met_threshold ? 'Attained' : 'Not Attained'}
                              </span>
                            </div>
                            <div className="h-5 w-full overflow-hidden rounded-full bg-slate-100">
                              <div className={`h-full rounded-full ${co.met_threshold ? 'bg-green-500' : 'bg-red-400'}`} style={{ width: `${Math.min(co.attainment_percentage, 100)}%` }} />
                            </div>
                            <p className="mt-1 text-xs text-slate-400">
                              {co.students_attained} of {co.total_students} students attained
                            </p>
                            {/* Per-question breakdown */}
                            {co.per_question.length > 0 && (
                              <div className="mt-3 overflow-hidden rounded border border-slate-100">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-50 text-left text-slate-500">
                                    <tr>
                                      <th className="px-3 py-1.5">Question</th>
                                      <th className="px-3 py-1.5">Max Marks</th>
                                      <th className="px-3 py-1.5">Attained</th>
                                      <th className="px-3 py-1.5">Total</th>
                                      <th className="px-3 py-1.5">%</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100">
                                    {co.per_question.map((pq) => (
                                      <tr key={pq.question_id} className="text-slate-600">
                                        <td className="px-3 py-1.5 font-mono">Q{pq.question_no}</td>
                                        <td className="px-3 py-1.5">{pq.max_marks}</td>
                                        <td className="px-3 py-1.5">{pq.attained}</td>
                                        <td className="px-3 py-1.5">{pq.total}</td>
                                        <td className={`px-3 py-1.5 font-medium ${pq.percentage >= attainment.threshold ? 'text-green-600' : 'text-red-500'}`}>
                                          {pq.percentage.toFixed(1)}%
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">No data yet.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Step 4: Download Tabulation PDF */}
        {activeCourseId != null && activeAssessmentId != null && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">4</div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-slate-900">Download Tabulation Sheet (PDF)</h2>
                <p className="mb-3 text-sm text-slate-600">
                  Generate the formal tabulation sheet with marks, CO attainment, and signature lines. Print, envelope, and send to the exam controller.
                </p>
                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <input type="text" placeholder="Prepared By (Course Teacher)" value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  <input type="text" placeholder="Moderator" value={moderatorBy} onChange={(e) => setModeratorBy(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  <input type="text" placeholder="Chairman / Controller" value={chairmanBy} onChange={(e) => setChairmanBy(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
                <button onClick={handleDownloadPdf} disabled={pdfBusy} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">
                  {pdfBusy ? 'Generating PDF...' : 'Download Tabulation PDF'}
                </button>
                <button onClick={handlePreviewHtml} className="ml-2 rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:bg-slate-50">
                  Preview HTML
                </button>
                <p className="mt-2 text-xs text-slate-400">
                  Uses threshold: {threshold}%. PDF requires Chrome or Edge installed. Preview opens in a new tab (no Chrome needed).
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Step 5: Approval Workflow */}
        {activeCourseId != null && activeAssessmentId != null && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">5</div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-slate-900">Approval Workflow</h2>
                <p className="mb-4 text-sm text-slate-600">
                  Track the grading sheet through the approval pipeline. Advance the status once each stage is complete.
                </p>

                {/* Workflow progress bar */}
                {sheetLoading ? (
                  <p className="text-sm text-slate-500">Loading...</p>
                ) : sheet ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-1">
                      {WORKFLOW_STEPS.map((step, i) => {
                        const currentIndex = WORKFLOW_STEPS.indexOf(sheet.status as typeof WORKFLOW_STEPS[number]);
                        const isDone = i <= currentIndex;
                        const isCurrent = i === currentIndex;
                        return (
                          <div key={step} className="flex flex-1 items-center">
                            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                              isDone ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'
                            } ${isCurrent ? 'ring-2 ring-blue-400 ring-offset-2' : ''}`}>
                              {i + 1}
                            </div>
                            {i < WORKFLOW_STEPS.length - 1 && (
                              <div className={`h-1 flex-1 ${i < currentIndex ? 'bg-blue-600' : 'bg-slate-200'}`} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-xs">
                      {WORKFLOW_STEPS.map((step) => (
                        <span key={step} className={`font-medium ${sheet.status === step ? 'text-blue-600' : 'text-slate-400'}`}>
                          {STATUS_LABELS[step]}
                        </span>
                      ))}
                    </div>

                    {/* Current status badge */}
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-slate-600">Current status:</span>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[sheet.status] ?? 'bg-gray-100 text-gray-700'}`}>
                        {STATUS_LABELS[sheet.status] ?? sheet.status}
                      </span>
                    </div>

                    {/* Audit trail */}
                    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
                      <table className="w-full">
                        <tbody>
                          {sheet.prepared_by && <tr><td className="py-0.5 font-medium">Prepared by:</td><td>{sheet.prepared_by}</td><td className="text-slate-400">{sheet.submitted_at ? new Date(sheet.submitted_at).toLocaleString() : ''}</td></tr>}
                          {sheet.moderated_by && <tr><td className="py-0.5 font-medium">Moderated by:</td><td>{sheet.moderated_by}</td><td className="text-slate-400">{sheet.moderated_at ? new Date(sheet.moderated_at).toLocaleString() : ''}</td></tr>}
                          {sheet.verified_by && <tr><td className="py-0.5 font-medium">Verified by:</td><td>{sheet.verified_by}</td><td className="text-slate-400">{sheet.verified_at ? new Date(sheet.verified_at).toLocaleString() : ''}</td></tr>}
                          {sheet.published_by && <tr><td className="py-0.5 font-medium">Published by:</td><td>{sheet.published_by}</td><td className="text-slate-400">{sheet.published_at ? new Date(sheet.published_at).toLocaleString() : ''}</td></tr>}
                        </tbody>
                      </table>
                    </div>

                    {/* Advance button */}
                    {sheet.status !== 'published' && NEXT_STATUS[sheet.status] && (
                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          placeholder="Your name (for the audit trail)"
                          value={workflowActor}
                          onChange={(e) => setWorkflowActor(e.target.value)}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                        <button
                          onClick={handleAdvanceWorkflow}
                          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
                        >
                          Advance to "{STATUS_LABELS[NEXT_STATUS[sheet.status]]}"
                        </button>
                      </div>
                    )}
                    {sheet.status === 'published' && (
                      <p className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
                        This grading sheet is published. No further changes allowed.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">No grading sheet for this assessment.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Browse existing results */}
        {courses.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Browse Existing Results</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <select
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                value={browseCourseId ?? ''}
                onChange={(e) => setBrowseCourseId(Number(e.target.value) || null)}
              >
                <option value="">Select course...</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.course_code} — {c.title}</option>
                ))}
              </select>
              <select
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                value={activeAssessmentId ?? ''}
                onChange={(e) => {
                  const aid = Number(e.target.value);
                  setActiveAssessmentId(aid || null);
                  setActiveCourseId(browseCourseId);
                }}
              >
                <option value="">Select assessment...</option>
                {assessments.map((a) => (
                  <option key={a.id} value={a.id}>{a.title}</option>
                ))}
              </select>
            </div>
            {activeAssessment && (
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-slate-400">
                  Viewing: {activeAssessment.title} · {activeAssessment.total_marks} marks · {activeAssessment.exam_date || 'no exam date'}
                </p>
                <button
                  onClick={handleDeleteAssessment}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  Delete Assessment
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
