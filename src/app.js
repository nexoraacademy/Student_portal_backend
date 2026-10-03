import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import dotenv from 'dotenv'
import apiRouter from './routes/index.js'
import authRouter from './routes/auth.js'
import { requirePasswordChangeComplete, requireStudent } from './auth.js'
import { notFound, errorHandler } from './middleware/errors.js'

dotenv.config()

const app = express()
const allowedOrigin = process.env.CLIENT_URL || 'http://localhost:5173'

app.use(cors({ origin: allowedOrigin, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'student-portal-api' }))
app.use('/api/auth', authRouter)
app.use('/api', requireStudent, requirePasswordChangeComplete, apiRouter)
app.use(notFound)
app.use(errorHandler)

export default app
