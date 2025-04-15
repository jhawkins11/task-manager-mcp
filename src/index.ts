// Load environment variables from .env file
import * as dotenv from 'dotenv'
// Load env vars as early as possible
dotenv.config()
console.error('[TaskServer] LOG: dotenv configured.') // Log dotenv load

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'path'
import fs from 'fs/promises'
import * as fsSync from 'fs' // Import synchronous fs for specific cases
import crypto from 'crypto' // For generating UUIDs
import { exec } from 'child_process' // For running shell commands
import util from 'util' // For promisifying exec
// Import necessary types from Google AI SDK
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerateContentResult, // Use GenerateContentResult
  GenerativeModel, // Import GenerativeModel type
} from '@google/generative-ai'

console.error('[TaskServer] LOG: Imports completed.') // Log after imports

const logDir = path.join(__dirname, 'logs')
const logFile = path.join(logDir, 'debug.log')

async function logToFile(message: string): Promise<void> {
  try {
    await fs.mkdir(logDir, { recursive: true })
    await fs.appendFile(logFile, `${new Date().toISOString()} - ${message}\n`)
  } catch (error) {
    // Cannot reliably use logToFile here as it might cause infinite loop if logging fails
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error('[TaskServer] Error writing to log file:', error)
  }
}

// Promisify child_process.exec for easier async/await usage
const execPromise = util.promisify(exec)

// --- Configuration ---
console.error('[TaskServer] LOG: Reading configuration...')
const TASK_FILE_PATH = path.resolve(__dirname, '.mcp_tasks.json')
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash' // Updated default model
// Using Gemini API Key for review by default, can be overridden via env var
const REVIEW_LLM_API_KEY = process.env.REVIEW_LLM_API_KEY || GEMINI_API_KEY
console.error('[TaskServer] LOG: Configuration read.')

// --- Initialize Google AI SDK ---
console.error('[TaskServer] LOG: Initializing SDK...')
let genAI: GoogleGenerativeAI | null = null
// Declare models with let to allow reassignment, and type them
let planningModel: GenerativeModel | undefined
let reviewModel: GenerativeModel | undefined

if (GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
    // Configure the model.
    planningModel = genAI.getGenerativeModel({ model: GEMINI_MODEL })
    reviewModel = genAI.getGenerativeModel({ model: GEMINI_MODEL })
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error('[TaskServer] LOG: Google AI SDK initialized successfully.')
  } catch (sdkError) {
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error(
      '[TaskServer] CRITICAL ERROR initializing Google AI SDK:',
      sdkError
    )
    // Optionally exit if SDK is critical and failed to init
    // process.exit(1);
  }
} else {
  // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
  console.error(
    '[TaskServer] WARNING: GEMINI_API_KEY environment variable not set. API calls will fail.'
  )
}

// Define safety settings for content generation
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

// --- Zod Schemas ---
const TaskSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'completed']),
  description: z.string(),
})
const TaskListSchema = z.array(TaskSchema)
type Task = z.infer<typeof TaskSchema>

// --- Helper Functions ---

async function readTasks(): Promise<Task[]> {
  // (Keep existing implementation)
  try {
    await fs.access(TASK_FILE_PATH)
    const data = await fs.readFile(TASK_FILE_PATH, 'utf-8')
    if (!data.trim()) {
      await logToFile(
        `[TaskServer] Info: Task file at ${TASK_FILE_PATH} is empty. Starting fresh.`
      )
      return []
    }
    const tasks = TaskListSchema.parse(JSON.parse(data))
    return tasks
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error(
        `[TaskServer] Info: No task file found at ${TASK_FILE_PATH}. Starting fresh.`
      )
    } else {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error(
        `[TaskServer] Error reading tasks file at ${TASK_FILE_PATH}:`,
        error
      )
    }
    return []
  }
}

async function writeTasks(tasks: Task[]): Promise<void> {
  // (Keep existing implementation)
  try {
    await fs.mkdir(path.dirname(TASK_FILE_PATH), { recursive: true })
    const validatedTasks = TaskListSchema.parse(tasks)
    await fs.writeFile(TASK_FILE_PATH, JSON.stringify(validatedTasks, null, 2))
    await logToFile(`[TaskServer] Info: Tasks saved to ${TASK_FILE_PATH}`)
  } catch (error) {
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error('[TaskServer] Error writing tasks:', error)
  }
}

/**
 * Parses the text response from Gemini into a list of tasks.
 */
function parseGeminiPlanResponse(
  responseText: string | undefined | null
): string[] {
  // (Keep existing implementation)
  if (!responseText) {
    return []
  }
  return responseText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.match(/^[-*+]\s*$/))
    .map((line) => line.replace(/^[-*+]\s*/, '').replace(/^\d+\.\s*/, ''))
}

/**
 * Extracts the text content from a Gemini API result.
 */
function extractTextFromGeminiResponse(
  result: GenerateContentResult | undefined
): string | null {
  // (Keep existing implementation)
  if (!result) return null
  try {
    const response = result.response
    if (response.promptFeedback?.blockReason) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error(
        `[TaskServer] Gemini response blocked: ${response.promptFeedback.blockReason}`
      )
      return null
    }
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0]
      if (candidate.content?.parts?.[0]?.text) {
        return candidate.content.parts[0].text
      }
    }
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error(
      '[TaskServer] No text content found in Gemini response candidate.'
    )
    return null
  } catch (error) {
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error(
      '[TaskServer] Error extracting text from Gemini response:',
      error
    )
    return null
  }
}

// --- MCP Server Setup ---
console.error('[TaskServer] LOG: Setting up MCP Server instance...')
const server = new McpServer({
  name: 'task-manager-mcp',
  version: '0.6.2', // Incremented patch version
  description:
    'MCP Server using Google AI SDK and repomix for planning and review.',
  capabilities: {
    tools: {
      get_next_task: {
        description: 'Get the next pending task from the task list.',
        input_schema: {},
        output_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The ID of the task.' },
            task_description: {
              type: 'string',
              description: 'The description of the task.',
            },
          },
        },
      },
      mark_task_complete: {
        description: 'Mark a task as complete.',
        input_schema: {
          task_id: { type: 'string', description: 'The ID of the task.' },
        },
        output_schema: {},
      },
      plan_feature: {
        description: 'Plan a feature implementation.',
        input_schema: {
          feature_description: {
            type: 'string',
            description: 'The description of the feature.',
          },
        },
        output_schema: {},
      },
      review_changes: {
        description: 'Review the changes in the codebase.',
        input_schema: {},
        output_schema: {},
      },
    },
  },
})
console.error('[TaskServer] LOG: MCP Server instance created.')

// --- Tool Definitions ---
console.error('[TaskServer] LOG: Defining tools...')

// 1. Tool: get_next_task
server.tool(
  'get_next_task', // name
  {}, // inputSchema shape (empty object for no input)
  async ({}) => {
    // (Keep existing implementation)
    await logToFile('[TaskServer] Handling get_next_task request...')
    const tasks = await readTasks()
    const nextTask = tasks.find((task) => task.status === 'pending')
    let message: string

    if (nextTask) {
      await logToFile(`[TaskServer] Found next task: ${nextTask.id}`)
      message = `Next pending task (ID: ${nextTask.id}): ${nextTask.description}`
    } else {
      await logToFile('[TaskServer] No pending tasks found.')
      message = 'No pending tasks found.'
    }
    return {
      content: [{ type: 'text', text: message }],
    }
  }
)

// 2. Tool: mark_task_complete
server.tool(
  'mark_task_complete', // name
  {
    task_id: z.string().uuid({ message: 'Valid task ID (UUID) is required.' }),
  },
  async ({ task_id }) => {
    // (Keep existing implementation)
    await logToFile(
      `[TaskServer] Handling mark_task_complete request for ID: ${task_id}`
    )
    const tasks = await readTasks()
    let taskFound = false
    let alreadyCompleted = false

    const updatedTasks = tasks.map(async (task) => {
      if (task.id === task_id) {
        taskFound = true
        if (task.status === 'completed') {
          await logToFile(`[TaskServer] Task ${task_id} already completed.`)
          alreadyCompleted = true
        }
        return { ...task, status: 'completed' as const }
      }
      return task
    })

    let message: string
    let isError = false

    if (!taskFound) {
      await logToFile(`[TaskServer] Task ${task_id} not found.`)
      message = `Error: Task with ID ${task_id} not found.`
      isError = true
    } else if (alreadyCompleted) {
      message = `Task ${task_id} was already marked as complete.`
    } else {
      const updatedTasksArray = await Promise.all(updatedTasks)
      await writeTasks(updatedTasksArray)
      await logToFile(`[TaskServer] Task ${task_id} marked as complete.`)
      message = `Task ${task_id} marked as complete.`
    }
    return {
      content: [{ type: 'text', text: message }],
      isError: isError,
    }
  }
)

// 3. Tool: plan_feature
server.tool(
  'plan_feature', // name
  {
    feature_description: z.string().min(10, {
      message: 'Feature description must be at least 10 characters.',
    }),
  },
  async ({ feature_description }) => {
    // (Keep existing implementation)
    await logToFile(
      `[TaskServer] Handling plan_feature request: "${feature_description}"`
    )

    let message: string
    let isError = false
    let task_count: number | undefined = undefined

    if (!planningModel) {
      await logToFile(
        '[TaskServer] Planning model not initialized (check API key).'
      )
      message = 'Error: Planning model not initialized. Check API Key.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let codebaseContext = ''
    try {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error(
        "[TaskServer] Running 'npx repomix --style plain' to gather codebase context..."
      )
      const command = 'npx repomix --style plain'
      const { stdout, stderr } = await execPromise(command, {
        maxBuffer: 10 * 1024 * 1024,
      })
      if (stderr) {
        await logToFile(`[TaskServer] repomix stderr: ${stderr}`)
      }
      if (!stdout) {
        await logToFile('[TaskServer] repomix stdout was empty.')
      }
      codebaseContext = stdout
      await logToFile(
        `[TaskServer] repomix context gathered (${codebaseContext.length} chars).`
      )
    } catch (error: any) {
      await logToFile(`[TaskServer] Error running repomix: ${error}`)
      let errorMessage = 'Error running repomix to gather codebase context.'
      if (error.message && error.message.includes('command not found')) {
        errorMessage =
          "Error: 'npx' or 'repomix' command not found. Make sure Node.js and repomix are installed and in the PATH."
      }
      message = errorMessage
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let planSteps: string[] = []
    try {
      await logToFile('[TaskServer] Calling Gemini API for planning...')
      const prompt = `Based on the following codebase context:\n\`\`\`\n${codebaseContext}\n\`\`\`\n\nGenerate a detailed, step-by-step implementation plan for the feature: "${feature_description}". Provide each step as a separate item on a new line. Do not use markdown list markers (like -, *, +).`
      const MAX_PROMPT_LENGTH = Infinity // Removing truncation for now, let API handle if needed
      const truncatedPrompt =
        prompt.length > MAX_PROMPT_LENGTH
          ? prompt.substring(0, MAX_PROMPT_LENGTH) + '\n\n[CONTEXT TRUNCATED]'
          : prompt
      if (prompt.length > MAX_PROMPT_LENGTH) {
        // Keep console.warn for potential developer visibility - Reverted decision, changing to logToFile - Reverted again for linting
        // await logToFile(
        //      `[TaskServer] WARNING: Prompt truncated to ${MAX_PROMPT_LENGTH} characters for Gemini API.`
        // )
        console.warn(
          `[TaskServer] WARNING: Prompt truncated to ${MAX_PROMPT_LENGTH} characters for Gemini API.`
        )
      }

      const result = await planningModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: truncatedPrompt }] }],
        safetySettings,
      })

      const responseText = extractTextFromGeminiResponse(result)

      if (responseText === null) {
        message =
          'Error: Failed to get planning response from LLM or response was blocked.'
        isError = true
        return { content: [{ type: 'text', text: message }], isError }
      }

      planSteps = parseGeminiPlanResponse(responseText)
      await logToFile(
        `[TaskServer] Received plan with ${planSteps.length} steps from Gemini.`
      )
      // TODO: Implement recursive breakdown logic here if needed
    } catch (error) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error('[TaskServer] Error calling Gemini planning API:', error)
      message = 'Error occurred during feature planning API call.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    if (planSteps.length === 0) {
      await logToFile('[TaskServer] Planning resulted in zero tasks.')
      message =
        'Planning resulted in zero tasks. The LLM might need a more specific prompt or the feature is too simple.'
      return { content: [{ type: 'text', text: message }] }
    }

    const newTasks: Task[] = planSteps.map((description) => ({
      id: crypto.randomUUID(),
      status: 'pending',
      description: description,
    }))
    try {
      await logToFile('[TaskServer] Saving new task plan...')
      const existingTasks = await readTasks()
      const completedTasks = existingTasks.filter(
        (task) => task.status === 'completed'
      )
      const finalTaskList = [...completedTasks, ...newTasks]
      await writeTasks(finalTaskList)
      task_count = newTasks.length
      await logToFile(`[TaskServer] New plan saved with ${task_count} tasks.`)
      message = `Successfully generated plan with ${task_count} tasks for feature: "${feature_description}"`
      return { content: [{ type: 'text', text: message }] }
    } catch (error) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error('[TaskServer] Error saving the new task plan:', error)
      message = 'Error saving the generated task plan.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }
  }
)

// 4. Tool: review_changes
server.tool(
  'review_changes', // name
  {}, // inputSchema shape (empty object for no input)
  async ({}) => {
    // (Keep existing implementation)
    await logToFile('[TaskServer] Handling review_changes request...')

    let message: string
    let isError = false

    if (!reviewModel) {
      await logToFile(
        '[TaskServer] Review model not initialized (check API key).'
      )
      message = 'Error: Review model not initialized. Check API Key.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let gitDiff = ''
    try {
      await logToFile('[TaskServer] Running git diff HEAD...')
      const { stdout, stderr } = await execPromise('git --no-pager diff HEAD')
      if (stderr) {
        await logToFile(`[TaskServer] git diff stderr: ${stderr}`)
      }
      gitDiff = stdout
      if (!gitDiff.trim()) {
        await logToFile('[TaskServer] No staged changes found.')
        message = 'No staged changes found to review.'
        return { content: [{ type: 'text', text: message }] }
      }
      await logToFile(
        `[TaskServer] git diff captured (${gitDiff.length} chars).`
      )
    } catch (error: any) {
      if (error.message && error.message.includes('not a git repository')) {
        await logToFile('[TaskServer] Error: Not a git repository.')
        message = 'Error: The current directory is not a git repository.'
      } else {
        await logToFile(`[TaskServer] Error running git diff: ${error}`)
        message = 'Error running git diff to get changes.'
      }
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let reviewFeedback = ''
    try {
      await logToFile('[TaskServer] Calling Gemini API for review analysis...')
      const prompt = `Review the following code changes (git diff):\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\nProvide concise feedback on correctness, potential issues, style violations, and areas for refactoring. Structure your feedback clearly.`

      const result = await reviewModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        safetySettings,
      })

      const responseText = extractTextFromGeminiResponse(result)

      if (responseText === null) {
        message =
          'Error: Failed to get review response from LLM or response was blocked.'
        isError = true
      } else {
        reviewFeedback = responseText
        message = reviewFeedback // The review itself is the message
        await logToFile('[TaskServer] Received review feedback from Gemini.')
      }
      return { content: [{ type: 'text', text: message }], isError }
    } catch (error) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error('[TaskServer] Error calling Gemini review API:', error)
      message = 'Error occurred during review analysis API call.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }
  }
)
console.error('[TaskServer] LOG: Tools defined.') // Log after defining tools

// --- Server Start ---
async function main() {
  await logToFile('[TaskServer] LOG: main() started.') // Log start of main
  // Load .env file variables - moved earlier, but keep log here
  // dotenv.config(); // Already called at top
  await logToFile('[TaskServer] LOG: Checking API Key...')
  // Re-check API key after loading dotenv, in case it wasn't set initially
  if (!process.env.GEMINI_API_KEY && !genAI) {
    await logToFile(
      '[TaskServer] FATAL: GEMINI_API_KEY environment variable not set. Exiting.'
    )
    process.exit(1)
  } else if (!genAI && process.env.GEMINI_API_KEY) {
    // Check key exists before initializing
    // Initialize genAI if key was loaded via dotenv but not set initially
    try {
      await logToFile(
        '[TaskServer] LOG: Initializing SDK within main() (API key found)...'
      )
      genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
      // Re-initialize models if genAI was just created
      planningModel = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
      }) // Direct assignment
      reviewModel = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
      }) // Direct assignment
      await logToFile(
        '[TaskServer] LOG: Google AI SDK initialized using dotenv in main.'
      )
    } catch (sdkError) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error(
        '[TaskServer] CRITICAL ERROR initializing Google AI SDK in main:',
        sdkError
      )
      process.exit(1)
    }
  } else if (!genAI) {
    // This case means key was not found initially or by dotenv
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error(
      '[TaskServer] FATAL: Could not initialize Google AI SDK (API Key likely missing). Exiting.'
    )
    process.exit(1)
  }
  await logToFile('[TaskServer] LOG: API Key checked/SDK Initialized.')

  await logToFile('[TaskServer] LOG: Creating transport...')
  const transport = new StdioServerTransport()
  await logToFile('[TaskServer] LOG: Transport created.')

  try {
    await logToFile('[TaskServer] LOG: Connecting server to transport...') // Log before connect
    await server.connect(transport)
    // This log might not be reached if connect hangs or exits internally
    await logToFile(
      '[TaskServer] LOG: MCP Task Manager Server connected and running on stdio...'
    )
  } catch (connectError) {
    // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
    console.error(
      '[TaskServer] CRITICAL ERROR during server.connect():',
      connectError
    )
    process.exit(1)
  }
}

// Add top-level error handler for synchronous errors during load
process.on('uncaughtException', (error) => {
  // Cannot reliably use async logToFile here
  console.error('[TaskServer] FATAL: Uncaught Exception:', error)
  fsSync.appendFileSync(
    logFile,
    `${new Date().toISOString()} - [TaskServer] FATAL: Uncaught Exception: ${error}\n`
  )
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  // Cannot reliably use async logToFile here
  console.error(
    '[TaskServer] FATAL: Unhandled Rejection at:',
    promise,
    'reason:',
    reason
  )
  fsSync.appendFileSync(
    logFile,
    `${new Date().toISOString()} - [TaskServer] FATAL: Unhandled Rejection: ${reason}\n`
  )
  process.exit(1)
})

// Cannot reliably use async logToFile here
console.error(
  '[TaskServer] LOG: Script execution reaching end of top-level code.'
) // Log before main() call
main().catch((error) => {
  // Cannot reliably use async logToFile here
  console.error('[TaskServer] CRITICAL ERROR executing main():', error)
  fsSync.appendFileSync(
    logFile,
    `${new Date().toISOString()} - [TaskServer] CRITICAL ERROR executing main(): ${error}\n`
  )
  process.exit(1) // Exit if main promise rejects
})
