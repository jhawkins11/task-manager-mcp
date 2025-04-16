import path from 'path'
import fs from 'fs/promises'

// --- User's Logging Setup ---
const logDir = path.join(__dirname, '../../logs')
const logFile = path.join(logDir, 'debug.log')

/**
 * Logs a message to the debug log file
 * @param message The message to log
 */
export async function logToFile(message: string): Promise<void> {
  try {
    // Ensure log directory exists every time
    await fs.mkdir(logDir, { recursive: true })
    await fs.appendFile(logFile, `${new Date().toISOString()} - ${message}\n`)
  } catch (error) {
    // Fallback to console if file logging fails
    console.error(`[TaskServer] Error writing to log file (${logFile}):`, error)
    console.error(`[TaskServer] Original log message: ${message}`)
  }
}
