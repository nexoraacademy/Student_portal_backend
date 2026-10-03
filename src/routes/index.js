import { Router } from 'express'
import { pool } from '../db.js'

const router = Router()

async function getEnrolment(studentId) {
  const [rows] = await pool.execute(
    `SELECT e.id AS enrolmentId, e.programme_id AS programmeId, e.status AS enrolmentStatus,
            e.completion_status AS completionStatus, p.name AS programmeName, p.description AS programmeDescription
       FROM enrolments e JOIN programmes p ON p.id = e.programme_id
      WHERE e.student_id = ? AND e.status IN ('Active', 'Paused')
      ORDER BY e.enrolled_at DESC, e.id DESC LIMIT 1`,
    [studentId],
  )
  return rows[0] || null
}

async function getClassStatus(enrolmentId, moduleId) {
  const [rows] = await pool.execute(
    `SELECT status, class_date AS classDate, notes
       FROM attendance WHERE enrolment_id = ? AND module_id = ?
      ORDER BY class_date DESC, id DESC LIMIT 1`,
    [enrolmentId, moduleId],
  )
  return rows[0] || null
}

async function getModuleAssessment(enrolmentId, moduleId) {
  const [rows] = await pool.execute(
    `SELECT a.id, a.kind, a.title, a.instructions, a.due_date AS dueDate, a.max_score AS maxScore,
            r.score, r.feedback, r.gradedAt
       FROM assessments a
       LEFT JOIN (
         SELECT assessment_id, enrolment_id, MAX(score) AS score, MAX(feedback) AS feedback,
                MAX(graded_at) AS gradedAt
           FROM results WHERE enrolment_id = ? GROUP BY assessment_id, enrolment_id
       ) r ON r.assessment_id = a.id AND r.enrolment_id = ?
      WHERE a.module_id = ? AND a.kind IN ('Quiz', 'Assessment')
      ORDER BY a.id DESC LIMIT 1`,
    [enrolmentId, enrolmentId, moduleId],
  )
  return rows[0] || null
}

async function getProgress(enrolmentId, moduleId) {
  const [rows] = await pool.execute(
    `SELECT progress_percent AS progressPercent, status, content_opened AS contentOpened,
            recording_watched AS recordingWatched
       FROM student_module_progress WHERE enrolment_id = ? AND module_id = ? LIMIT 1`,
    [enrolmentId, moduleId],
  )
  return rows[0] || { progressPercent: 0, status: 'Not Started', contentOpened: 0, recordingWatched: 0 }
}

async function moduleHasPassed(enrolmentId, moduleId) {
  const assessment = await getModuleAssessment(enrolmentId, moduleId)
  return Boolean(assessment && Number(assessment.maxScore) > 0 && Number(assessment.score) >= 0 && (Number(assessment.score) / Number(assessment.maxScore)) * 100 >= 80)
}

async function shapeModule(enrolmentId, module) {
  const [lessons] = await pool.execute(
    'SELECT id, title, content, lesson_order AS lessonOrder FROM lessons WHERE module_id = ? ORDER BY lesson_order, id',
    [module.id],
  )
  const [progress, attendance, assessment] = await Promise.all([
    getProgress(enrolmentId, module.id),
    getClassStatus(enrolmentId, module.id),
    getModuleAssessment(enrolmentId, module.id),
  ])
  const attendanceStatus = attendance?.status === 'Present' || attendance?.status === 'Late'
    ? 'attended'
    : attendance?.status === 'Absent' ? 'absent' : 'pending'
  const assessmentPassed = Boolean(assessment && Number(assessment.maxScore) > 0 && (Number(assessment.score) / Number(assessment.maxScore)) * 100 >= 80)
  return {
    id: String(module.id), order: module.sequenceNo, title: module.name, description: module.description,
    progressPercent: Number(progress.progressPercent || 0), progressStatus: progress.status,
    contentOpened: Boolean(progress.contentOpened), lessons,
    class: { title: module.name, date: module.classDate, time: module.classTime, location: module.classLocation, attendanceStatus, recordingUrl: module.recordingUrl },
    assessment: assessment && assessmentPassed ? { id: assessment.id, title: assessment.title, kind: assessment.kind, instructions: assessment.instructions, dueDate: assessment.dueDate, score: Number(assessment.score), maxScore: Number(assessment.maxScore), passed: true } : null,
    assessmentAvailable: Boolean(progress.contentOpened && (attendanceStatus === 'attended' || (attendanceStatus === 'absent' && progress.recordingWatched))),
    recordingWatched: Boolean(progress.recordingWatched),
    assessmentPassed,
  }
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const [studentRows] = await pool.execute(
      `SELECT s.id, a.first_name AS firstName, a.last_name AS lastName
         FROM students s JOIN applicants a ON a.id = s.applicant_id WHERE s.id = ? LIMIT 1`,
      [req.student.id],
    )
    const enrolment = await getEnrolment(req.student.id)
    if (!enrolment) return res.json({ student: studentRows[0] || { id: req.student.id }, programme: null, stats: { programmeSections: 0, assignmentsDue: 0, averageGrade: null }, upcomingAssignments: [] })
    const [[moduleStats]] = await pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN p.status = 'Completed' AND p.progress_percent >= 100 THEN 1 ELSE 0 END) AS completed
         FROM modules m LEFT JOIN student_module_progress p ON p.module_id = m.id AND p.enrolment_id = ?
        WHERE m.programme_id = ?`,
      [enrolment.enrolmentId, enrolment.programmeId],
    )
    const [upcomingAssignments] = await pool.execute(
      `SELECT a.id, a.title, m.name AS section, a.due_date AS dueDate, a.max_score AS maxScore
         FROM assessments a JOIN modules m ON m.id = a.module_id
        WHERE m.programme_id = ? AND a.kind = 'Assignment' AND (a.due_date IS NULL OR a.due_date >= CURRENT_DATE())
        ORDER BY a.due_date IS NULL, a.due_date LIMIT 5`,
      [enrolment.programmeId],
    )
    const [[gradeStats]] = await pool.execute(
      `SELECT ROUND(AVG(r.score / NULLIF(a.max_score, 0) * 100), 1) AS averageGrade
         FROM results r JOIN assessments a ON a.id = r.assessment_id
        WHERE r.enrolment_id = ?`,
      [enrolment.enrolmentId],
    )
    res.json({
      student: studentRows[0] || { id: req.student.id },
      programme: { id: enrolment.programmeId, title: enrolment.programmeName, sectionCount: Number(moduleStats.total || 0) },
      stats: { programmeSections: Number(moduleStats.total || 0), completedSections: Number(moduleStats.completed || 0), assignmentsDue: upcomingAssignments.length, averageGrade: gradeStats.averageGrade == null ? null : Number(gradeStats.averageGrade) },
      upcomingAssignments,
    })
  } catch (error) { next(error) }
})

router.get('/programme', async (req, res, next) => {
  try {
    const enrolment = await getEnrolment(req.student.id)
    if (!enrolment) return res.json({ programme: null, sections: [] })
    const [modules] = await pool.execute(
      `SELECT id, sequence_no AS sequenceNo, name, description,
              class_date AS classDate, class_time AS classTime,
              class_location AS classLocation, recording_url AS recordingUrl
         FROM modules WHERE programme_id = ? ORDER BY sequence_no, id`,
      [enrolment.programmeId],
    )
    const sections = []
    for (const [index, module] of modules.entries()) {
      let unlocked = index === 0
      if (index > 0) unlocked = await moduleHasPassed(enrolment.enrolmentId, modules[index - 1].id)
      sections.push({ ...(await shapeModule(enrolment.enrolmentId, module)), unlocked })
    }
    res.json({ programme: { id: enrolment.programmeId, title: enrolment.programmeName, description: enrolment.programmeDescription }, sections })
  } catch (error) { next(error) }
})

router.get('/sections/:sectionId', async (req, res, next) => {
  try {
    const enrolment = await getEnrolment(req.student.id)
    if (!enrolment) return res.status(404).json({ error: 'No active programme enrolment found' })
    const [modules] = await pool.execute(
      `SELECT id, sequence_no AS sequenceNo, name, description,
              class_date AS classDate, class_time AS classTime,
              class_location AS classLocation, recording_url AS recordingUrl
         FROM modules WHERE programme_id = ? ORDER BY sequence_no, id`,
      [enrolment.programmeId],
    )
    const index = modules.findIndex((module) => String(module.id) === req.params.sectionId)
    if (index < 0) return res.status(404).json({ error: 'Section not found' })
    if (index > 0 && !(await moduleHasPassed(enrolment.enrolmentId, modules[index - 1].id))) return res.status(403).json({ error: 'Pass the previous section with at least 80% to unlock this section' })
    const shaped = await shapeModule(enrolment.enrolmentId, modules[index])
    const [assessmentRows] = await pool.execute(
      `SELECT id, kind, title, instructions, due_date AS dueDate, max_score AS maxScore
         FROM assessments WHERE module_id = ? AND kind IN ('Quiz', 'Assessment') ORDER BY id DESC LIMIT 1`,
      [modules[index].id],
    )
    const classReady = shaped.class.attendanceStatus === 'attended' || (shaped.class.attendanceStatus === 'absent' && shaped.recordingWatched)
    let assessment = shaped.contentOpened && classReady ? assessmentRows[0] || null : null
    if (assessment) {
      const [questions] = await pool.execute(
        `SELECT id, question_text AS questionText, question_type AS questionType, options, points, question_order AS questionOrder
           FROM assessment_questions WHERE assessment_id = ? ORDER BY question_order, id`,
        [assessment.id],
      )
      assessment.questions = questions.map((question) => ({ ...question, options: typeof question.options === 'string' ? JSON.parse(question.options) : question.options }))
      const [attempts] = await pool.execute(
        `SELECT id, attempt_no AS attemptNo, status, score, feedback, submitted_at AS submittedAt, graded_at AS gradedAt
           FROM student_assessment_attempts WHERE assessment_id = ? AND enrolment_id = ? ORDER BY attempt_no DESC LIMIT 1`,
        [assessment.id, enrolment.enrolmentId],
      )
      assessment.latestAttempt = attempts[0] || null
      const [results] = await pool.execute('SELECT MAX(score) AS bestScore FROM results WHERE assessment_id = ? AND enrolment_id = ?', [assessment.id, enrolment.enrolmentId])
      assessment.bestScore = results[0]?.bestScore == null ? null : Number(results[0].bestScore)
    }
    res.json({ section: { ...shaped, assessment } })
  } catch (error) { next(error) }
})

router.post('/sections/:sectionId/assessment', async (req, res, next) => {
  try {
    const access = await getAccessibleModule(req, req.params.sectionId)
    if (access.error) return res.status(access.status).json({ error: access.error })
    const section = await shapeModule(access.enrolment.enrolmentId, access.module)
    const classReady = section.class.attendanceStatus === 'attended' || (section.class.attendanceStatus === 'absent' && section.recordingWatched)
    if (!section.contentOpened || !classReady) return res.status(403).json({ error: 'Open the content and meet the class attendance or recording requirement first' })
    const [assessmentRows] = await pool.execute("SELECT id FROM assessments WHERE module_id = ? AND kind IN ('Quiz', 'Assessment') ORDER BY id DESC LIMIT 1", [access.module.id])
    const assessment = assessmentRows[0]
    if (!assessment) return res.status(404).json({ error: 'No assessment has been added for this section' })
    const [pendingAttempts] = await pool.execute("SELECT id FROM student_assessment_attempts WHERE assessment_id = ? AND enrolment_id = ? AND status = 'Submitted' LIMIT 1", [assessment.id, access.enrolment.enrolmentId])
    if (pendingAttempts.length) return res.status(409).json({ error: 'Your latest attempt is still waiting for the lecturer to grade it' })
    const responses = req.body.responses
    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) return res.status(400).json({ error: 'Assessment responses are required' })
    const [questions] = await pool.execute('SELECT id, question_type AS questionType, options FROM assessment_questions WHERE assessment_id = ?', [assessment.id])
    if (!questions.length) return res.status(409).json({ error: 'The lecturer has not configured assessment questions yet' })
    for (const question of questions) {
      const response = responses[String(question.id)]
      if (typeof response !== 'string' || !response.trim()) return res.status(400).json({ error: 'Answer every assessment question before submitting' })
      if (question.questionType === 'Multiple Choice') {
        const options = typeof question.options === 'string' ? JSON.parse(question.options) : question.options
        const allowed = Array.isArray(options) ? options.map((option) => typeof option === 'string' ? option : option.value) : []
        if (!allowed.includes(response)) return res.status(400).json({ error: 'One or more selected answers are invalid' })
      }
    }
    const [[attemptCount]] = await pool.execute('SELECT COUNT(*) AS total FROM student_assessment_attempts WHERE assessment_id = ? AND enrolment_id = ?', [assessment.id, access.enrolment.enrolmentId])
    const attemptNo = Number(attemptCount.total) + 1
    await pool.execute('INSERT INTO student_assessment_attempts (assessment_id, enrolment_id, attempt_no, responses) VALUES (?, ?, ?, ?)', [assessment.id, access.enrolment.enrolmentId, attemptNo, JSON.stringify(responses)])
    res.status(202).json({ ok: true, attemptNo, status: 'Submitted' })
  } catch (error) { next(error) }
})

router.get('/assignments', async (req, res, next) => {
  try {
    const enrolment = await getEnrolment(req.student.id)
    if (!enrolment) return res.json({ assignments: [] })
    const [assignments] = await pool.execute(
      `SELECT a.id, a.title, m.name AS section, a.instructions, a.due_date AS dueDate,
              a.max_score AS maxScore, r.score, r.graded_at AS gradedAt
         FROM assessments a JOIN modules m ON m.id = a.module_id
         LEFT JOIN results r ON r.assessment_id = a.id AND r.enrolment_id = ?
        WHERE m.programme_id = ? AND a.kind = 'Assignment'
        ORDER BY a.due_date IS NULL, a.due_date, a.id`,
      [enrolment.enrolmentId, enrolment.programmeId],
    )
    res.json({ assignments: assignments.map((item) => ({ ...item, status: item.score == null ? 'Not submitted' : 'Graded' })) })
  } catch (error) { next(error) }
})

router.get('/results', async (req, res, next) => {
  try {
    const enrolment = await getEnrolment(req.student.id)
    if (!enrolment) return res.json({ results: [], termAverage: null })
    const [results] = await pool.execute(
      `SELECT r.id, a.title AS assessment, m.name AS section, r.score, a.max_score AS maxScore,
              r.feedback, r.graded_at AS releasedAt,
              ROUND(r.score / NULLIF(a.max_score, 0) * 100, 1) AS percentage
         FROM results r JOIN assessments a ON a.id = r.assessment_id
         JOIN modules m ON m.id = a.module_id
        WHERE r.enrolment_id = ? ORDER BY r.graded_at DESC, r.id DESC`,
      [enrolment.enrolmentId],
    )
    const [[average]] = await pool.execute(
      `SELECT ROUND(AVG(r.score / NULLIF(a.max_score, 0) * 100), 1) AS termAverage
         FROM results r JOIN assessments a ON a.id = r.assessment_id WHERE r.enrolment_id = ?`,
      [enrolment.enrolmentId],
    )
    res.json({ results, termAverage: average.termAverage == null ? null : Number(average.termAverage) })
  } catch (error) { next(error) }
})

router.get('/announcements', async (req, res, next) => {
  try {
    const [announcements] = await pool.execute(
      `SELECT a.id, a.title, a.body, a.published_at AS publishedAt,
              (SELECT COUNT(*) FROM notifications n WHERE n.announcement_id = a.id AND n.student_id = ? AND n.read_at IS NOT NULL) > 0 AS isRead
         FROM announcements a
        WHERE a.status = 'Published' AND a.audience IN ('Students', 'Everyone')
        ORDER BY a.published_at DESC, a.id DESC`,
      [req.student.id],
    )
    res.json({ announcements })
  } catch (error) { next(error) }
})

router.get('/certificates', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.id, c.certificate_number AS certificateNumber, c.completion_date AS completionDate,
              c.issue_date AS issueDate, c.expires_at AS expiresAt, c.status, p.name AS programme,
              rr.status AS renewalStatus
         FROM certificates c JOIN students s ON s.applicant_id = c.applicant_id
         JOIN programmes p ON p.id = c.programme_id
         LEFT JOIN certificate_renewal_requests rr ON rr.certificate_id = c.id AND rr.student_id = s.id
        WHERE s.id = ? ORDER BY c.issue_date DESC`,
      [req.student.id],
    )
    res.json({ certificates: rows })
  } catch (error) { next(error) }
})

router.get('/profile', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.id AS studentNumber, s.status, a.first_name AS firstName, a.last_name AS lastName,
              a.email, a.phone, a.date_of_birth AS dateOfBirth, a.address,
              p.name AS programme, e.start_date AS startDate, e.status AS enrolmentStatus
         FROM students s JOIN applicants a ON a.id = s.applicant_id
         LEFT JOIN enrolments e ON e.student_id = s.id AND e.status IN ('Active', 'Paused')
         LEFT JOIN programmes p ON p.id = e.programme_id
        WHERE s.id = ? ORDER BY e.enrolled_at DESC LIMIT 1`,
      [req.student.id],
    )
    if (!rows[0]) return res.status(404).json({ error: 'Student profile not found' })
    res.json({ student: rows[0] })
  } catch (error) { next(error) }
})

async function saveProgressValue(enrolmentId, moduleId, column, value) {
  const [rows] = await pool.execute('SELECT id FROM student_module_progress WHERE enrolment_id = ? AND module_id = ? ORDER BY id LIMIT 1', [enrolmentId, moduleId])
  if (rows[0]) {
    await pool.execute(`UPDATE student_module_progress SET ${column} = ?, status = 'In Progress', progress_percent = GREATEST(progress_percent, 1), updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [value, rows[0].id])
  } else {
    await pool.execute(`INSERT INTO student_module_progress (enrolment_id, module_id, progress_percent, status, ${column}) VALUES (?, ?, 1, 'In Progress', ?)`, [enrolmentId, moduleId, value])
  }
}

async function getAccessibleModule(req, sectionId) {
  const enrolment = await getEnrolment(req.student.id)
  if (!enrolment) return { error: 'No active programme enrolment found', status: 404 }
  const [modules] = await pool.execute('SELECT id FROM modules WHERE programme_id = ? ORDER BY sequence_no, id', [enrolment.programmeId])
  const index = modules.findIndex((module) => String(module.id) === String(sectionId))
  if (index < 0) return { error: 'Section not found', status: 404 }
  if (index > 0 && !(await moduleHasPassed(enrolment.enrolmentId, modules[index - 1].id))) return { error: 'Pass the previous section with at least 80% to unlock this section', status: 403 }
  return { enrolment, module: modules[index] }
}

router.post('/sections/:sectionId/content-opened', async (req, res, next) => {
  try {
    const access = await getAccessibleModule(req, req.params.sectionId)
    if (access.error) return res.status(access.status).json({ error: access.error })
    await saveProgressValue(access.enrolment.enrolmentId, access.module.id, 'content_opened', 1)
    res.json({ ok: true })
  } catch (error) { next(error) }
})

router.post('/sections/:sectionId/recording-watched', async (req, res, next) => {
  try {
    const access = await getAccessibleModule(req, req.params.sectionId)
    if (access.error) return res.status(access.status).json({ error: access.error })
    const [attendance] = await pool.execute('SELECT status FROM attendance WHERE enrolment_id = ? AND module_id = ? ORDER BY class_date DESC, id DESC LIMIT 1', [access.enrolment.enrolmentId, access.module.id])
    const [modules] = await pool.execute('SELECT recording_url AS recordingUrl FROM modules WHERE id = ? LIMIT 1', [access.module.id])
    if (attendance[0]?.status !== 'Absent' || !modules[0]?.recordingUrl) return res.status(403).json({ error: 'A lecturer-recorded absence and uploaded recording are required' })
    await saveProgressValue(access.enrolment.enrolmentId, access.module.id, 'recording_watched', 1)
    res.json({ ok: true })
  } catch (error) { next(error) }
})

router.post('/announcements/:announcementId/read', async (req, res, next) => {
  try {
    const announcementId = Number(req.params.announcementId)
    const [existing] = await pool.execute('SELECT id FROM notifications WHERE announcement_id = ? AND student_id = ? ORDER BY id LIMIT 1', [announcementId, req.student.id])
    if (existing[0]) await pool.execute('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ?', [existing[0].id])
    else await pool.execute('INSERT INTO notifications (announcement_id, student_id, read_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [announcementId, req.student.id])
    res.json({ ok: true })
  } catch (error) { next(error) }
})

router.post('/certificates/:certificateId/renew', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.id, c.expires_at AS expiresAt FROM certificates c
       JOIN students s ON s.applicant_id = c.applicant_id
       WHERE c.id = ? AND s.id = ? AND c.status = 'Valid' LIMIT 1`,
      [Number(req.params.certificateId), req.student.id],
    )
    const certificate = rows[0]
    if (!certificate) return res.status(404).json({ error: 'Certificate not found' })
    const expiry = certificate.expiresAt ? new Date(`${String(certificate.expiresAt).slice(0, 10)}T23:59:59`) : null
    if (!expiry || expiry >= new Date()) return res.status(409).json({ error: 'Renewal can be requested after this certificate expires' })
    await pool.execute(
      `INSERT INTO certificate_renewal_requests (certificate_id, student_id, status)
       VALUES (?, ?, 'Requested') ON DUPLICATE KEY UPDATE status = IF(status = 'Rejected', 'Requested', status), requested_at = IF(status = 'Rejected', CURRENT_TIMESTAMP, requested_at)`,
      [certificate.id, req.student.id],
    )
    res.status(202).json({ ok: true, status: 'Requested' })
  } catch (error) { next(error) }
})
export default router



