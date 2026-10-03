import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import nodemailer from 'nodemailer'
import { pool } from '../db.js'
import { clearSessionCookie, createSession, hashPassword, requireStudent, setSessionCookie, verifyPassword } from '../auth.js'

const router = Router()

function adminAuthorized(req) {
  const configuredKey = process.env.ADMIN_API_KEY || ''
  const suppliedKey = req.get('x-admin-api-key') || ''
  if (!configuredKey || !suppliedKey) return false
  const expected = Buffer.from(configuredKey)
  const received = Buffer.from(suppliedKey)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function mailTransport() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !MAIL_FROM) return null
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  })
}

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const password = String(req.body.password || '')
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })
    const [rows] = await pool.execute(
      `SELECT s.id AS studentId, a.first_name AS firstName, a.last_name AS lastName,
              a.email, account.password_hash AS passwordHash,
              account.must_change_password AS mustChangePassword
         FROM students s
         JOIN applicants a ON a.id = s.applicant_id
         JOIN student_portal_accounts account ON account.student_id = s.id
        WHERE LOWER(a.email) = ? AND s.status = 'Active'
        LIMIT 1`,
      [email],
    )
    const account = rows[0]
    if (!account || !(await verifyPassword(password, account.passwordHash))) {
      return res.status(401).json({ error: 'Email or password is incorrect' })
    }
    const mustChangePassword = Boolean(account.mustChangePassword)
    setSessionCookie(res, createSession(account.studentId, mustChangePassword))
    res.json({ student: { id: account.studentId, firstName: account.firstName, lastName: account.lastName, email: account.email }, mustChangePassword })
  } catch (error) { next(error) }
})

router.get('/me', requireStudent, async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.id, a.first_name AS firstName, a.last_name AS lastName, a.email
         FROM students s JOIN applicants a ON a.id = s.applicant_id
        WHERE s.id = ? AND s.status = 'Active' LIMIT 1`,
      [req.student.id],
    )
    if (!rows[0]) { clearSessionCookie(res); return res.status(401).json({ error: 'Student account is not active' }) }
    res.json({ student: rows[0], mustChangePassword: req.student.mustChangePassword })
  } catch (error) { next(error) }
})

router.post('/change-temporary-password', requireStudent, async (req, res, next) => {
  try {
    const password = String(req.body.password || '')
    if (password.length < 12) return res.status(400).json({ error: 'Choose a password with at least 12 characters' })
    const passwordHash = await hashPassword(password)
    await pool.execute('UPDATE student_portal_accounts SET password_hash = ?, must_change_password = 0 WHERE student_id = ?', [passwordHash, req.student.id])
    setSessionCookie(res, createSession(req.student.id, false))
    res.json({ ok: true })
  } catch (error) { next(error) }
})

router.post('/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }) })

router.post('/admin/students/:studentId/accept', async (req, res, next) => {
  try {
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin authorization required' })
    const transport = mailTransport()
    if (!transport) return res.status(503).json({ error: 'Email delivery is not configured on the backend' })
    const studentId = Number(req.params.studentId)
    const [rows] = await pool.execute(
      `SELECT s.id, a.first_name AS firstName, a.last_name AS lastName, a.email
         FROM students s JOIN applicants a ON a.id = s.applicant_id
         JOIN applications app ON app.applicant_id = a.id
        WHERE s.id = ? AND s.status = 'Active' AND app.status = 'Accepted'
        LIMIT 1`,
      [studentId],
    )
    const student = rows[0]
    if (!student) return res.status(404).json({ error: 'No accepted active student found' })
    const [existingAccounts] = await pool.execute('SELECT student_id FROM student_portal_accounts WHERE student_id = ? LIMIT 1', [student.id])
    if (existingAccounts.length) return res.status(409).json({ error: 'Student portal account already exists' })
    const temporaryPassword = randomBytes(12).toString('base64url')
    const passwordHash = await hashPassword(temporaryPassword)
    await pool.execute(
      'INSERT INTO student_portal_accounts (student_id, password_hash, must_change_password) VALUES (?, ?, 1)',
      [student.id, passwordHash],
    )
    try {
      await transport.sendMail({
        from: process.env.MAIL_FROM,
        to: student.email,
        subject: 'Your Nexora Academy student portal login',
        text: `Hello ${student.firstName},\n\nYour student portal account is ready. Sign in with your email address and this temporary password: ${temporaryPassword}\n\nYou will be asked to choose a new password after signing in.`,
      })
    } catch (mailError) {
      await pool.execute('DELETE FROM student_portal_accounts WHERE student_id = ?', [student.id])
      throw mailError
    }
    res.status(202).json({ ok: true, message: 'Student account created and temporary password emailed' })
  } catch (error) { next(error) }
})

export default router



