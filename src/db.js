import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
})

async function hasColumn(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )
  return Number(rows[0].count) > 0
}

async function addColumn(table, column, definition) {
  if (!(await hasColumn(table, column))) await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

export async function initializePortalSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS student_portal_accounts (
      student_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      password_hash VARCHAR(255) NOT NULL,
      must_change_password TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_portal_account_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await addColumn('attendance', 'module_id', 'INT UNSIGNED NULL AFTER enrolment_id')
  await addColumn('modules', 'class_date', 'DATE NULL')
  await addColumn('modules', 'class_time', 'VARCHAR(80) NULL')
  await addColumn('modules', 'class_location', 'VARCHAR(180) NULL')
  await addColumn('modules', 'recording_url', 'VARCHAR(1000) NULL')
  await addColumn('student_module_progress', 'content_opened', 'TINYINT(1) NOT NULL DEFAULT 0')
  await addColumn('student_module_progress', 'recording_watched', 'TINYINT(1) NOT NULL DEFAULT 0')
  await addColumn('certificates', 'expires_at', 'DATE NULL')
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS certificate_renewal_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      certificate_id BIGINT UNSIGNED NOT NULL,
      student_id BIGINT UNSIGNED NOT NULL,
      status ENUM('Requested', 'Under Review', 'Approved', 'Rejected') NOT NULL DEFAULT 'Requested',
      requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_certificate_renewal (certificate_id, student_id),
      CONSTRAINT fk_renewal_certificate FOREIGN KEY (certificate_id) REFERENCES certificates(id) ON DELETE CASCADE,
      CONSTRAINT fk_renewal_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS assessment_questions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      assessment_id BIGINT UNSIGNED NOT NULL,
      question_text TEXT NOT NULL,
      question_type ENUM('Multiple Choice', 'Code', 'Short Answer') NOT NULL DEFAULT 'Short Answer',
      options JSON NULL,
      answer_key JSON NULL,
      points DECIMAL(8,2) NOT NULL DEFAULT 1,
      question_order INT UNSIGNED NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_portal_question_assessment FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE,
      INDEX ix_portal_question_assessment_order (assessment_id, question_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS student_assessment_attempts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      assessment_id BIGINT UNSIGNED NOT NULL,
      enrolment_id BIGINT UNSIGNED NOT NULL,
      attempt_no INT UNSIGNED NOT NULL,
      responses JSON NOT NULL,
      status ENUM('Submitted', 'Graded') NOT NULL DEFAULT 'Submitted',
      score DECIMAL(8,2) NULL,
      feedback TEXT NULL,
      submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      graded_at DATETIME NULL,
      UNIQUE KEY uq_portal_assessment_attempt (assessment_id, enrolment_id, attempt_no),
      CONSTRAINT fk_portal_attempt_assessment FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE,
      CONSTRAINT fk_portal_attempt_enrolment FOREIGN KEY (enrolment_id) REFERENCES enrolments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}


