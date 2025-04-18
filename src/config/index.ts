// Load environment variables from .env file
import * as dotenv from 'dotenv'
import path from 'path'

// Load env vars as early as possible
dotenv.config()

// --- Configuration ---
const FEATURE_TASKS_DIR = path.resolve(__dirname, '../../.mcp', 'features') // Directory for feature-specific task files
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro-exp-03-25' // Default model
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'google/gemini-2.5-pro-exp-03-25:free'
const FALLBACK_OPENROUTER_MODEL =
  process.env.FALLBACK_OPENROUTER_MODEL ||
  'google/gemini-2.5-flash-preview:thinking'
const FALLBACK_GEMINI_MODEL =
  process.env.FALLBACK_GEMINI_MODEL || 'gemini-2.0-flash-thinking-exp-1219'
const REVIEW_LLM_API_KEY = process.env.REVIEW_LLM_API_KEY || GEMINI_API_KEY

// WebSocket server configuration
const WS_PORT = parseInt(process.env.WS_PORT || '4999', 10)
const WS_HOST = process.env.WS_HOST || 'localhost'
// UI server uses the same port as WebSocket
const UI_PORT = WS_PORT

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
  GEMINI_API_KEY,
  OPENROUTER_API_KEY,
  GEMINI_MODEL,
  OPENROUTER_MODEL,
  FALLBACK_OPENROUTER_MODEL,
  FALLBACK_GEMINI_MODEL,
  REVIEW_LLM_API_KEY,
  safetySettings,
  WS_PORT,
  WS_HOST,
  UI_PORT,
}
