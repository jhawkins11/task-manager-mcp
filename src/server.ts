import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import { logToFile } from './lib/logger'
import logger from './lib/winstonLogger'
import { handleMarkTaskComplete } from './tools/markTaskComplete'
import { handlePlanFeature } from './tools/planFeature'
import { handleReviewChanges } from './tools/reviewChanges'
import { AdjustPlanInputSchema, AdjustPlanInput } from './models/types'
import { adjustPlanHandler } from './tools/adjustPlan'
import webSocketService from './services/webSocketService'
import planningStateService from './services/planningStateService'
// Re-add static imports
import express, { Request, Response, NextFunction } from 'express'
import path from 'path'
import crypto from 'crypto'

import { FEATURE_TASKS_DIR, UI_PORT } from './config'
import { Task } from './models/types'
import { detectClarificationRequest } from './lib/llmUtils'
import { databaseService } from './services/databaseService'
import { addHistoryEntry } from './lib/dbUtils'

// Immediately log that we're starting up
logger.info('Starting task manager server...')

// --- MCP Server Setup ---
logger.info('Setting up MCP Server instance...')
const server = new McpServer({
  name: 'task-manager-mcp',
  version: '0.6.3',
  description:
    'MCP Server using Google AI SDK and repomix for planning and review.',
  capabilities: {
    tools: { listChanged: false },
  },
})
logger.info('MCP Server instance created.')

// --- Tool Definitions ---
logger.info('Defining tools...')

// New 'get_next_task' tool
server.tool(
  'get_next_task',
  {
    featureId: z
      .string()
      .uuid({ message: 'Valid feature ID (UUID) is required.' }),
  },
  async (args, _extra) => {
    try {
      const { featureId } = args
      await logToFile(
        `[TaskServer] Handling get_next_task request for feature: ${featureId}`
      )

      // 1. Read tasks for the given feature ID
      await databaseService.connect()
      const tasks = await databaseService.getTasksByFeatureId(featureId)
      await databaseService.close()

      if (tasks.length === 0) {
        const message = `No tasks found for feature ID ${featureId}. The feature may not exist or has not been planned yet.`
        await logToFile(`[TaskServer] ${message}`)
        return {
          content: [{ type: 'text', text: message }],
          isError: false,
        }
      }

      // 2. Find the first pending task in the list
      const nextTask = tasks.find((task) => task.status === 'pending')

      if (!nextTask) {
        const message = `All tasks have been completed for feature ${featureId}.`
        await logToFile(`[TaskServer] ${message}`)
        return {
          content: [{ type: 'text', text: message }],
          isError: false,
        }
      }

      // 3. Format response with task details
      // Include effort in the message if available
      const effortInfo = nextTask.effort ? ` (Effort: ${nextTask.effort})` : ''

      // Include parent info if this is a subtask
      let parentInfo = ''
      if (nextTask.parent_task_id) {
        // Find the parent task
        const parentTask = tasks.find((t) => t.id === nextTask.parent_task_id)
        if (parentTask) {
          const parentDesc =
            parentTask.description && parentTask.description.length > 30
              ? parentTask.description.substring(0, 30) + '...'
              : parentTask.description || '' // Use empty string if description is undefined
          parentInfo = ` (Subtask of: "${parentDesc}")`
        } else {
          parentInfo = ` (Subtask of parent ID: ${nextTask.parent_task_id})` // Fallback if parent not found
        }
      }

      // Embed ID, description, effort, and parent info in the text message
      const message = `Next pending task (ID: ${nextTask.id})${effortInfo}${parentInfo}: ${nextTask.description}`

      await logToFile(`[TaskServer] Found next task: ${nextTask.id}`)

      return {
        content: [{ type: 'text', text: message }],
        isError: false,
      }
    } catch (error: any) {
      const errorMsg = `Error processing get_next_task request: ${
        error instanceof Error ? error.message : String(error)
      }`
      logger.error(errorMsg)
      await logToFile(`[TaskServer] ${errorMsg}`)

      return {
        content: [{ type: 'text', text: errorMsg }],
        isError: true,
      }
    }
  }
)

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
    // Since handlePlanFeature now always returns Array<{type: 'text', text: string}>
    // we can use a simple map.
    return {
      content: result.content.map((item) => ({
        type: 'text',
        text: item.text,
      })),
      isError: result.isError,
    }
  }
)

// 3. Tool: review_changes
server.tool(
  'review_changes',
  {
    project_path: z
      .string()
      .optional()
      .describe(
        'The absolute path to the project directory where git commands should run. Defaults to the workspace root if not provided.'
      ),
    featureId: z
      .string()
      .uuid({ message: 'Valid feature ID (UUID) is required.' }),
  },
  async (args, _extra) => {
    // Pass the project_path argument to the handler
    const result = await handleReviewChanges({
      featureId: args.featureId,
      project_path: args.project_path,
    })
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

// 4. Tool: adjust_plan
server.tool(
  'adjust_plan',
  {
    featureId: z
      .string()
      .uuid({ message: 'Valid feature ID (UUID) is required.' }),
    adjustment_request: z
      .string()
      .min(1, { message: 'Adjustment request cannot be empty.' }),
  },
  async (args: AdjustPlanInput, _extra) => {
    const result = await adjustPlanHandler(args)

    return {
      content: [{ type: 'text', text: result.message }],
      isError: result.status === 'error',
    }
  }
)

logger.info('Tools defined.')

// --- Error Handlers ---
// Add top-level error handler for synchronous errors during load
process.on('uncaughtException', (error) => {
  // Cannot reliably use async logToFile here
  logger.error('Uncaught Exception:', error)
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
    logger.error('Error writing uncaughtException to sync log:', logErr)
  }
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  try {
    const logDir = process.env.LOG_DIR || './logs'
    const logFile = process.env.LOG_FILE || `${logDir}/debug.log`
    fsSync.mkdirSync(logDir, { recursive: true })
    fsSync.appendFileSync(
      logFile,
      `${new Date().toISOString()} - [TaskServer] FATAL: Unhandled Rejection: ${reason}\n`
    )
  } catch (logErr) {
    logger.error('Error writing unhandledRejection to sync log:', logErr)
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
    logger.error('Error listing features:', error)
    return []
  }
}

// Helper function to format a task for the frontend
function formatTaskForFrontend(task: any, featureId: string) {
  return {
    id: task.id,
    title: task.title || task.description,
    description: task.description,
    status: task.status,
    completed: task.status === 'completed' || Boolean(task.completed),
    effort: task.effort,
    feature_id: featureId,
    // Convert from snake_case to camelCase for frontend compatibility
    parentTaskId: task.parent_task_id,
    createdAt:
      typeof task.created_at === 'number'
        ? new Date(task.created_at * 1000).toISOString()
        : task.createdAt,
    updatedAt:
      typeof task.updated_at === 'number'
        ? new Date(task.updated_at * 1000).toISOString()
        : task.updatedAt,
  }
}

// --- Server Start ---
async function main() {
  await logToFile('[TaskServer] LOG: main() started.')
  logger.info('Main function started')

  try {
    // --- Express Server Setup --- Moved inside main, after MCP connect
    const app = express()
    const PORT = process.env.PORT || UI_PORT || 4999

    // HTTP request logging middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = new Date().getTime()

      res.on('finish', () => {
        const duration = new Date().getTime() - start
        logger.info({
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: `${duration}ms`,
        })
      })

      next()
    })

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
          logger.error(`Failed to fetch features: ${error?.message || error}`)
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
          await databaseService.connect()
          const tasks = await databaseService.getTasksByFeatureId(featureId)
          await databaseService.close()

          // Use the helper function to format tasks
          const formattedTasks = tasks.map((task) =>
            formatTaskForFrontend(task, featureId)
          )

          res.json(formattedTasks)
        } catch (error: any) {
          logger.error(
            `Failed to fetch tasks for feature ${featureId}: ${
              error?.message || error
            }`
          )
          await logToFile(
            `[TaskServer] ERROR fetching tasks for feature ${featureId}: ${
              error?.message || error
            }`
          )
          res.status(500).json({ error: 'Failed to fetch tasks' })
        }
      })()
    })

    // Parse JSON bodies for API requests
    app.use(express.json())

    // POST: Create a new task
    app.post('/api/tasks', (req: Request, res: Response) => {
      ;(async () => {
        try {
          const { featureId, description, title, effort } = req.body

          // Use title if description is missing
          const taskDescription = description || title

          if (!featureId || !taskDescription) {
            return res.status(400).json({
              error:
                'Missing required fields: featureId and title are required',
            })
          }

          // Read existing tasks
          await databaseService.connect()
          const tasks = await databaseService.getTasksByFeatureId(featureId)

          // Create a new task with a UUID
          const now = Math.floor(Date.now() / 1000)
          const newTask = {
            id: crypto.randomUUID(),
            description: taskDescription,
            title: title || taskDescription, // Use title or derived description
            status: 'pending' as const,
            completed: false,
            effort: effort as 'low' | 'medium' | 'high' | undefined,
            feature_id: featureId,
            created_at: now,
            updated_at: now,
          }

          // Convert to DB format and add to database
          await databaseService.addTask(newTask)

          // Add the new task to the list for WS notifications
          tasks.push(newTask)

          // Notify clients via WebSocket - both general task update and specific creation event
          webSocketService.broadcast({
            type: 'tasks_updated',
            featureId,
            payload: {
              tasks: tasks.map((task) =>
                formatTaskForFrontend(task, featureId)
              ),
              updatedAt: new Date().toISOString(),
            },
          })

          // Also send a specific task created notification
          webSocketService.notifyTaskCreated(
            featureId,
            formatTaskForFrontend(newTask, featureId)
          )

          await databaseService.close()
          res.status(201).json(formatTaskForFrontend(newTask, featureId))
        } catch (error: any) {
          logger.error(`Failed to create task: ${error?.message || error}`)
          await logToFile(
            `[TaskServer] ERROR creating task: ${error?.message || error}`
          )
          res.status(500).json({ error: 'Failed to create task' })
        }
      })()
    })

    // PUT: Update an existing task
    app.put('/api/tasks/:taskId', (req: Request, res: Response) => {
      ;(async () => {
        try {
          const { taskId } = req.params
          const { featureId, description, title, status, completed, effort } =
            req.body

          if (!featureId) {
            return res
              .status(400)
              .json({ error: 'Missing required field: featureId' })
          }

          // Read existing tasks
          await databaseService.connect()

          // Check if task exists
          const task = await databaseService.getTaskById(taskId)

          if (!task) {
            await databaseService.close()
            return res.status(404).json({ error: 'Task not found' })
          }

          // First determine what kind of update we need (status or details)
          if (status || completed !== undefined) {
            // Status update
            const newStatus = status || task.status
            const isCompleted =
              completed !== undefined ? completed : task.completed
            await databaseService.updateTaskStatus(
              taskId,
              newStatus,
              isCompleted
            )
          }

          // If we have other fields to update, do that as well
          if (title || description || effort) {
            await databaseService.updateTaskDetails(taskId, {
              title: title,
              description: description,
              effort: effort as 'low' | 'medium' | 'high' | undefined,
            })
          }

          // Get updated tasks for WebSocket notification
          const tasks = await databaseService.getTasksByFeatureId(featureId)
          const updatedTask = await databaseService.getTaskById(taskId)

          // Notify clients via WebSocket - both general task update and specific update event
          webSocketService.broadcast({
            type: 'tasks_updated',
            featureId,
            payload: {
              tasks: tasks.map((task) =>
                formatTaskForFrontend(task, featureId)
              ),
              updatedAt: new Date().toISOString(),
            },
          })

          // Send a specific task updated notification
          webSocketService.notifyTaskUpdated(
            featureId,
            formatTaskForFrontend(updatedTask!, featureId)
          )

          // Also send a status change notification if the status was updated
          if (status) {
            webSocketService.notifyTaskStatusChanged(featureId, taskId, status)
          }

          await databaseService.close()
          res.json(formatTaskForFrontend(updatedTask!, featureId))
        } catch (error: any) {
          logger.error(`Failed to update task: ${error?.message || error}`)
          await logToFile(
            `[TaskServer] ERROR updating task: ${error?.message || error}`
          )
          res.status(500).json({ error: 'Failed to update task' })
        }
      })()
    })

    // DELETE: Remove a task
    app.delete('/api/tasks/:taskId', (req: Request, res: Response) => {
      ;(async () => {
        try {
          const { taskId } = req.params
          const { featureId } = req.query

          if (!featureId) {
            return res
              .status(400)
              .json({ error: 'Missing required query parameter: featureId' })
          }

          // Connect to database
          await databaseService.connect()

          // Get the task before deletion for the response
          const task = await databaseService.getTaskById(taskId)

          if (!task) {
            await databaseService.close()
            return res.status(404).json({ error: 'Task not found' })
          }

          // Delete the task
          const deleted = await databaseService.deleteTask(taskId)

          if (!deleted) {
            await databaseService.close()
            return res.status(404).json({ error: 'Failed to delete task' })
          }

          // Get updated tasks for WebSocket notification
          const remainingTasks = await databaseService.getTasksByFeatureId(
            featureId as string
          )

          // Notify clients via WebSocket - both general task update and specific deletion event
          webSocketService.broadcast({
            type: 'tasks_updated',
            featureId: featureId as string,
            payload: {
              tasks: remainingTasks.map((task) =>
                formatTaskForFrontend(task, featureId as string)
              ),
              updatedAt: new Date().toISOString(),
            },
          })

          // Send a specific task deleted notification
          webSocketService.notifyTaskDeleted(featureId as string, taskId)

          await databaseService.close()
          res.json({
            message: 'Task deleted successfully',
            task: formatTaskForFrontend(task, featureId as string),
          })
        } catch (error: any) {
          logger.error(`Failed to delete task: ${error?.message || error}`)
          await logToFile(
            `[TaskServer] ERROR deleting task: ${error?.message || error}`
          )
          res.status(500).json({ error: 'Failed to delete task' })
        }
      })()
    })

    // Get pending question for a specific feature
    app.get(
      '/api/features/:featureId/pending-question',
      (req: Request, res: Response) => {
        ;(async () => {
          const { featureId } = req.params
          try {
            const state = planningStateService.getStateByFeatureId(featureId)
            if (state && state.partialResponse) {
              // Attempt to parse the stored partialResponse as JSON
              let parsedData: any
              try {
                parsedData = JSON.parse(state.partialResponse)
              } catch (parseError) {
                logToFile(
                  `[TaskServer] Error parsing partialResponse JSON for feature ${featureId}: ${parseError}. Content: ${state.partialResponse}`
                )
                res.json(null) // Cannot parse the stored state
                return
              }

              // Check if the parsed data contains the clarificationNeeded structure
              if (parsedData && parsedData.clarificationNeeded) {
                const clarification = parsedData.clarificationNeeded
                logToFile(
                  `[TaskServer] Found pending question ${state.questionId} for feature ${featureId}`
                )
                res.json({
                  questionId: state.questionId, // Use the ID from the stored state
                  question: clarification.question,
                  options: clarification.options,
                  allowsText: clarification.allowsText,
                })
              } else {
                logToFile(
                  `[TaskServer] State found for feature ${featureId}, but partialResponse JSON did not contain 'clarificationNeeded'. Content: ${state.partialResponse}`
                )
                res.json(null) // Parsed data structure unexpected
              }
            } else {
              logToFile(
                `[TaskServer] No pending question found for feature ${featureId}`
              )
              res.json(null) // No pending question found
            }
          } catch (error: any) {
            logToFile(
              `[TaskServer] ERROR fetching pending question for feature ${featureId}: ${
                error?.message || error
              }`
            )
            res.status(500).json({ error: 'Failed to fetch pending question' })
          }
        })()
      }
    )

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
          await databaseService.connect()
          const tasks = await databaseService.getTasksByFeatureId(
            mostRecentFeatureId
          )
          await databaseService.close()

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
      logger.info(`Frontend server running at ${url}`)
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
      logger.error('WebSocket server initialization failed:', wsError)
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
    logger.error('CRITICAL ERROR during server.connect():', connectError)
    process.exit(1)
  }
}

logger.info('Script execution reaching end of top-level code.')
main().catch((error) => {
  logger.error('CRITICAL ERROR executing main():', error)
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
    logger.error('Error writing main() catch to sync log:', logErr)
  }
  process.exit(1) // Exit if main promise rejects
})
