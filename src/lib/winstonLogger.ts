import path from 'path'
import winston from 'winston'
import 'winston-daily-rotate-file'

const logDir = path.join(__dirname, '../../logs')

// Define log formats
const formats = {
  console: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(
      (info) => `${info.timestamp} ${info.level}: ${info.message}`
    )
  ),
  file: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
  ),
}

// Configure file transport with rotation
const fileRotateTransport = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: 'application-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  zippedArchive: true,
})

// Error log transport with rotation
const errorFileRotateTransport = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  level: 'error',
  zippedArchive: true,
})

// Create the logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: formats.file,
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: formats.console,
    }),
    // File transports with rotation
    fileRotateTransport,
    errorFileRotateTransport,
  ],
  exceptionHandlers: [
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'exceptions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'rejections-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true,
    }),
  ],
})

// Helper function to maintain compatibility with previous logger
export async function logToFile(message: string): Promise<void> {
  logger.debug(message)
}

export default logger
