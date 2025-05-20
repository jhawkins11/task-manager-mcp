// Load environment variables from .env file
import * as dotenv from 'dotenv'
import path from 'path'

// Load env vars as early as possible
dotenv.config()

// --- Configuration ---
const FEATURE_TASKS_DIR = path.resolve(__dirname, '../../.mcp', 'features') // Directory for feature-specific task files
const SQLITE_DB_PATH =
  process.env.SQLITE_DB_PATH ||
  path.resolve(__dirname, '../../data/taskmanager.db') // Path to SQLite database file
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-04-17' // Default model
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-preview:thinking'
const FALLBACK_OPENROUTER_MODEL =
  process.env.FALLBACK_OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'
const FALLBACK_GEMINI_MODEL =
  process.env.FALLBACK_GEMINI_MODEL || 'gemini-2.0-flash-001'
const REVIEW_LLM_API_KEY = process.env.REVIEW_LLM_API_KEY || GEMINI_API_KEY

// Logging configuration
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVEL = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'info' // Default to INFO

// WebSocket server configuration
const WS_PORT = parseInt(process.env.WS_PORT || '4999', 10)
const WS_HOST = process.env.WS_HOST || 'localhost'
// UI server uses the same port as WebSocket
const UI_PORT = WS_PORT

// Add config for git diff max buffer (in MB)
const GIT_DIFF_MAX_BUFFER_MB = parseInt(
  process.env.GIT_DIFF_MAX_BUFFER_MB || '10',
  10
)

// Add config for auto-review on completion
const AUTO_REVIEW_ON_COMPLETION =
  process.env.AUTO_REVIEW_ON_COMPLETION === 'true'

// Define safety settings for content generation
import { HarmCategory, HarmBlockThreshold } from '@google/generative-ai'
const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
]

export {
  FEATURE_TASKS_DIR,
  SQLITE_DB_PATH,
  GEMINI_API_KEY,
  OPENROUTER_API_KEY,
  GEMINI_MODEL,
  OPENROUTER_MODEL,
  FALLBACK_OPENROUTER_MODEL,
  FALLBACK_GEMINI_MODEL,
  REVIEW_LLM_API_KEY,
  LOG_LEVEL,
  LogLevel,
  safetySettings,
  WS_PORT,
  WS_HOST,
  UI_PORT,
  GIT_DIFF_MAX_BUFFER_MB,
  AUTO_REVIEW_ON_COMPLETION,
}
