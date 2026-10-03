import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const cookieName = 'student_portal_session'

export async function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash)
}

export function createSession(studentId, mustChangePassword = false) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured')
  return jwt.sign({ studentId, mustChangePassword }, process.env.JWT_SECRET, {
    expiresIn: mustChangePassword ? '20m' : '8h',
  })
}

export function setSessionCookie(res, token) {
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', path: '/' })
}

export function requireStudent(req, res, next) {
  const token = req.cookies?.[cookieName]
  if (!token) return res.status(401).json({ error: 'Please sign in to continue' })
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.student = { id: Number(payload.studentId), mustChangePassword: Boolean(payload.mustChangePassword) }
    next()
  } catch {
    clearSessionCookie(res)
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
  }
}

export function requirePasswordChangeComplete(req, res, next) {
  if (req.student.mustChangePassword) return res.status(403).json({ error: 'Change your temporary password to continue', code: 'PASSWORD_CHANGE_REQUIRED' })
  next()
}
