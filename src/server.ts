import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as fsSync from 'fs'
import { logToFile } from './lib/logger'
import { handleGetNextTask } from './tools/getNextTask'
import { handleMarkTaskComplete } from './tools/markTaskComplete'
import { handlePlanFeature } from './tools/planFeature'
import { handleReviewChanges } from './tools/reviewChanges'

// Immediately log that we're starting up
console.error('[TaskServer] LOG: Starting task manager server...')

// --- MCP Server Setup ---
console.error('[TaskServer] LOG: Setting up MCP Server instance...')
const server = new McpServer({
  name: 'task-manager-mcp',
  version: '0.6.3',
  description:
    'MCP Server using Google AI SDK and repomix for planning and review.',
  capabilities: {
    tools: { listChanged: false },
  },
})
console.error('[TaskServer] LOG: MCP Server instance created.')

// --- Tool Definitions ---
console.error('[TaskServer] LOG: Defining tools...')

// 1. Tool: get_next_task
server.tool(
  'get_next_task',
  {
    feature_id: z
      .string()
      .uuid({ message: 'Valid feature ID (UUID) is required.' }),
  },
  async (args, _extra) => {
    const result = await handleGetNextTask(args)
    // Transform the content to match SDK expected format
    return {
      content: result.content.map((item) => ({
        type: item.type as 'text',
        text: item.text,
      })),
      isError: result.isError,
    }
  }
)

// 2. Tool: mark_task_complete
server.tool(
  'mark_task_complete',
  {
    task_id: z.string().uuid({ message: 'Valid task ID (UUID) is required.' }),
    feature_id: z
      .string()
      .uuid({ message: 'Valid feature ID (UUID) is required.' }),
  },
  async (args, _extra) => {
    const result = await handleMarkTaskComplete(args)
    // Transform the content to match SDK expected format
    return {
      content: result.content.map((item) => ({
        type: item.type as 'text',
        text: item.text,
      })),
      isError: result.isError,
    }
  }
)

// 3. Tool: plan_feature
server.tool(
  'plan_feature',
  {
    feature_description: z.string().min(10, {
      message: 'Feature description must be at least 10 characters.',
    }),
    project_path: z
      .string()
      .describe(
        'The absolute path to the project directory to scan with repomix. '
      ),
  },
  async (args, _extra) => {
    const result = await handlePlanFeature(args)
    // Transform the content to match SDK expected format
    return {
      content: result.content.map((item) => ({
        type: item.type as 'text',
        text: item.text,
      })),
      isError: result.isError,
    }
  }
)

// 4. Tool: review_changes
server.tool('review_changes', {}, async (_args, _extra) => {
  const result = await handleReviewChanges()
  // Transform the content to match SDK expected format
  return {
    content: result.content.map((item) => ({
      type: item.type as 'text',
      text: item.text,
    })),
    isError: result.isError,
  }
})

console.error('[TaskServer] LOG: Tools defined.')

// --- Error Handlers ---
// Add top-level error handler for synchronous errors during load
process.on('uncaughtException', (error) => {
  // Cannot reliably use async logToFile here
  console.error('[TaskServer] FATAL: Uncaught Exception:', error)
  // Use synchronous append for critical errors before exit
  try {
    const logDir = process.env.LOG_DIR || './logs'
    const logFile = process.env.LOG_FILE || `${logDir}/debug.log`
    fsSync.mkdirSync(logDir, { recursive: true })
    fsSync.appendFileSync(
      logFile,
      `${new Date().toISOString()} - [TaskServer] FATAL: Uncaught Exception: ${
        error?.message || error
      }\n${error?.stack || ''}\n`
    )
  } catch (logErr) {
    console.error('Error writing uncaughtException to sync log:', logErr)
  }
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error(
    '[TaskServer] FATAL: Unhandled Rejection at:',
    promise,
    'reason:',
    reason
  )
  try {
    const logDir = process.env.LOG_DIR || './logs'
    const logFile = process.env.LOG_FILE || `${logDir}/debug.log`
    fsSync.mkdirSync(logDir, { recursive: true })
    fsSync.appendFileSync(
      logFile,
      `${new Date().toISOString()} - [TaskServer] FATAL: Unhandled Rejection: ${reason}\n`
    )
  } catch (logErr) {
    console.error('Error writing unhandledRejection to sync log:', logErr)
  }
  process.exit(1)
})

// --- Server Start ---
async function main() {
  await logToFile('[TaskServer] LOG: main() started.')

  try {
    await logToFile('[TaskServer] LOG: Creating transport...')
    const transport = new StdioServerTransport()
    await logToFile('[TaskServer] LOG: Transport created.')

    await logToFile('[TaskServer] LOG: Connecting server to transport...')
    await server.connect(transport)
    await logToFile(
      '[TaskServer] LOG: MCP Task Manager Server connected and running on stdio...'
    )
  } catch (connectError) {
    console.error(
      '[TaskServer] CRITICAL ERROR during server.connect():',
      connectError
    )
    process.exit(1)
  }
}

console.error(
  '[TaskServer] LOG: Script execution reaching end of top-level code.'
)
main().catch((error) => {
  console.error('[TaskServer] CRITICAL ERROR executing main():', error)
  try {
    const logDir = process.env.LOG_DIR || './logs'
    const logFile = process.env.LOG_FILE || `${logDir}/debug.log`
    fsSync.mkdirSync(logDir, { recursive: true })
    fsSync.appendFileSync(
      logFile,
      `${new Date().toISOString()} - [TaskServer] CRITICAL ERROR executing main(): ${
        error?.message || error
      }\n${error?.stack || ''}\n`
    )
  } catch (logErr) {
    console.error('Error writing main() catch to sync log:', logErr)
  }
  process.exit(1) // Exit if main promise rejects
})
