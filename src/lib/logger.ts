import logger from './winstonLogger'

/**
 * Logs a message to the debug log file
 * @param message The message to log
 */
export async function logToFile(message: string): Promise<void> {
  try {
    logger.debug(message)
  } catch (error) {
    // Fallback to console if logger fails
    console.error(`[TaskServer] Error using logger:`, error)
    console.error(`[TaskServer] Original log message: ${message}`)
  }
}
