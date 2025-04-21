import logger from './winstonLogger'
import { LOG_LEVEL, LogLevel } from '../config' // Import LOG_LEVEL and LogLevel type

// Define log level hierarchy (lower number = higher priority)
const levelHierarchy: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

const configuredLevel = levelHierarchy[LOG_LEVEL] || levelHierarchy.info // Default to INFO if invalid

/**
 * Logs a message to the debug log file if the provided level meets the configured threshold.
 * @param message The message to log
 * @param level The level of the message (default: 'info')
 */
export async function logToFile(
  message: string,
  level: LogLevel = 'info'
): Promise<void> {
  try {
    const messageLevel = levelHierarchy[level] || levelHierarchy.info

    // Only log if the message level is less than or equal to the configured level
    if (messageLevel <= configuredLevel) {
      switch (level) {
        case 'error':
          logger.error(message)
          break
        case 'warn':
          logger.warn(message)
          break
        case 'info':
          logger.info(message)
          break
        case 'debug':
        default:
          logger.debug(message) // Default to debug if level not specified or recognized
          break
      }
    }
  } catch (error) {
    // Fallback to console if logger fails
    console.error(`[TaskServer] Error using logger:`, error)
    console.error(
      `[TaskServer] Original log message (Level: ${level}): ${message}`
    )
  }
}
