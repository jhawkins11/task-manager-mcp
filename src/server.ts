import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import { logToFile } from './lib/logger'
import { handleMarkTaskComplete } from './tools/markTaskComplete'
import { handlePlanFeature } from './tools/planFeature'
import { handleReviewChanges } from './tools/reviewChanges'
import webSocketService from './services/webSocketService'
// Re-add static imports
import express, { Request, Response } from 'express'
import path from 'path'

import { readTasks } from './lib/fsUtils'
import { FEATURE_TASKS_DIR, UI_PORT } from './config'
import { Task } from './models/types'

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

// 1. Tool: mark_task_complete
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

// 2. Tool: plan_feature
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

// 3. Tool: review_changes
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

// Helper function to list all features
async function listFeatures() {
  try {
    // Ensure features directory exists
    await fs.mkdir(FEATURE_TASKS_DIR, { recursive: true })

    // Read all files in the features directory
    const files = await fs.readdir(FEATURE_TASKS_DIR)

    // Filter for task files (ending with _mcp_tasks.json)
    const taskFiles = files.filter((file) => file.endsWith('_mcp_tasks.json'))

    // Extract feature IDs from filenames
    const featureIds = taskFiles.map((file) =>
      file.replace('_mcp_tasks.json', '')
    )

    return featureIds
  } catch (error) {
    console.error('[TaskServer] Error listing features:', error)
    return []
  }
}

// Helper function to format a task for the frontend
function formatTaskForFrontend(task: Task, featureId: string) {
  return {
    ...task,
    // Use task.title if available, otherwise fall back to description
    title: task.title || task.description,
    // Directly use the status from the task data, ensuring all statuses are handled
    status: task.status,
    // The 'completed' field should accurately reflect the 'completed' status
    completed: task.status === 'completed',
    feature_id: featureId,
  }
}

// --- Server Start ---
async function main() {
  await logToFile('[TaskServer] LOG: main() started.')

  try {
    // --- Express Server Setup --- Moved inside main, after MCP connect
    const app = express()
    const PORT = process.env.PORT || UI_PORT || 4999

    // --- MCP Server Connection --- Moved after Express init
    await logToFile('[TaskServer] LOG: Creating transport...')
    const transport = new StdioServerTransport()
    await logToFile('[TaskServer] LOG: Transport created.')

    await logToFile('[TaskServer] LOG: Connecting server to transport...')
    await server.connect(transport)
    await logToFile(
      '[TaskServer] LOG: MCP Task Manager Server connected and running on stdio...'
    )

    // Setup API endpoints

    // Get list of features
    app.get('/api/features', (req: Request, res: Response) => {
      ;(async () => {
        try {
          const featureIds = await listFeatures()
          res.json(featureIds)
        } catch (error: any) {
          await logToFile(
            `[TaskServer] ERROR fetching features: ${error?.message || error}`
          )
          res.status(500).json({ error: 'Failed to fetch features' })
        }
      })()
    })

    // Get tasks for a specific feature
    app.get('/api/tasks/:featureId', (req: Request, res: Response) => {
      ;(async () => {
        const { featureId } = req.params
        try {
          const tasks = await readTasks(featureId)

          // Use the helper function to format tasks
          const formattedTasks = tasks.map((task) =>
            formatTaskForFrontend(task, featureId)
          )

          res.json(formattedTasks)
        } catch (error: any) {
          await logToFile(
            `[TaskServer] ERROR fetching tasks for feature ${featureId}: ${
              error?.message || error
            }`
          )
          res.status(500).json({ error: 'Failed to fetch tasks' })
        }
      })()
    })

    // Default endpoint to get tasks from most recent feature
    app.get('/api/tasks', (req: Request, res: Response) => {
      ;(async () => {
        try {
          const featureIds = await listFeatures()

          if (featureIds.length === 0) {
            // Return empty array if no features exist
            return res.json([])
          }

          // Sort feature IDs by creation time (using file stats)
          const featuresWithStats = await Promise.all(
            featureIds.map(async (featureId) => {
              const filePath = path.join(
                FEATURE_TASKS_DIR,
                `${featureId}_mcp_tasks.json`
              )
              const stats = await fs.stat(filePath)
              return { featureId, mtime: stats.mtime }
            })
          )

          // Sort by most recent modification time
          featuresWithStats.sort(
            (a, b) => b.mtime.getTime() - a.mtime.getTime()
          )

          // Get tasks for the most recent feature
          const mostRecentFeatureId = featuresWithStats[0].featureId
          const tasks = await readTasks(mostRecentFeatureId)

          // Use the helper function to format tasks
          const formattedTasks = tasks.map((task) =>
            formatTaskForFrontend(task, mostRecentFeatureId)
          )

          res.json(formattedTasks)
        } catch (error: any) {
          await logToFile(
            `[TaskServer] ERROR fetching default tasks: ${
              error?.message || error
            }`
          )
          res.status(500).json({ error: 'Failed to fetch tasks' })
        }
      })()
    })

    // Serve static frontend files
    const staticFrontendPath = path.join(__dirname, 'frontend-ui')
    app.use(express.static(staticFrontendPath))

    // Catch-all route to serve the SPA for any unmatched routes
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(staticFrontendPath, 'index.html'))
    })

    // Start the Express server and capture the HTTP server instance
    const httpServer = app.listen(PORT, () => {
      const url = `http://localhost:${PORT}`
      console.error(`[TaskServer] LOG: Frontend server running at ${url}`)
    })

    // Initialize WebSocket service with the HTTP server instance
    try {
      await webSocketService.initialize(httpServer)
      await logToFile(
        '[TaskServer] LOG: WebSocket server attached to HTTP server.'
      )
    } catch (wsError) {
      await logToFile(
        `[TaskServer] WARN: Failed to initialize WebSocket server: ${wsError}`
      )
      console.error(
        '[TaskServer] WARN: WebSocket server initialization failed:',
        wsError
      )
      // Decide if this is fatal or can continue
    }

    // Handle process termination gracefully
    process.on('SIGINT', async () => {
      await logToFile(
        '[TaskServer] LOG: Received SIGINT. Shutting down gracefully...'
      )

      // Shutdown WebSocket server
      try {
        await webSocketService.shutdown()
        await logToFile(
          '[TaskServer] LOG: WebSocket server shut down successfully.'
        )
      } catch (error) {
        await logToFile(
          `[TaskServer] ERROR: Error shutting down WebSocket server: ${error}`
        )
      }

      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      await logToFile(
        '[TaskServer] LOG: Received SIGTERM. Shutting down gracefully...'
      )

      // Shutdown WebSocket server
      try {
        await webSocketService.shutdown()
        await logToFile(
          '[TaskServer] LOG: WebSocket server shut down successfully.'
        )
      } catch (error) {
        await logToFile(
          `[TaskServer] ERROR: Error shutting down WebSocket server: ${error}`
        )
      }

      process.exit(0)
    })
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
