import app from './app.js'
import { initializePortalSchema, pool } from './db.js'

const port = Number(process.env.PORT) || 5000

try {
  await initializePortalSchema()
  app.listen(port, () => console.log(`Student portal API listening on port ${port}`))
} catch (error) {
  console.error('Unable to initialize MySQL portal schema:', error.code || error.message)
  await pool.end()
  process.exit(1)
}
