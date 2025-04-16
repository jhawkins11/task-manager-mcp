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

// Import OpenAI SDK for OpenRouter
import OpenAI from 'openai'

console.error('[TaskServer] LOG: Imports completed.') // Log after imports

// --- User's Logging Setup ---
const logDir = path.join(__dirname, 'logs')
const logFile = path.join(logDir, 'debug.log')

async function logToFile(message: string): Promise<void> {
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
// --- End User's Logging Setup ---

// Promisify child_process.exec for easier async/await usage
const execPromise = util.promisify(exec)

// --- Configuration ---
console.error('[TaskServer] LOG: Reading configuration...')
const TASK_FILE_PATH = path.resolve(__dirname, '.mcp_tasks.json')
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash' // Updated default model
// Default OpenRouter model - can be overridden via env var
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'google/gemini-2.5-pro-exp-03-25:free'
// Using Gemini API Key for review by default, can be overridden via env var
const REVIEW_LLM_API_KEY = process.env.REVIEW_LLM_API_KEY || GEMINI_API_KEY
console.error('[TaskServer] LOG: Configuration read.')

// --- Initialize AI SDKs ---
console.error('[TaskServer] LOG: Initializing SDK...')
let genAI: GoogleGenerativeAI | null = null
let openRouter: OpenAI | null = null
// Declare models with let to allow reassignment, and type them
let planningModel: GenerativeModel | undefined
let reviewModel: GenerativeModel | undefined

// Initialize OpenRouter if API key is available
if (OPENROUTER_API_KEY) {
  try {
    openRouter = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
    console.error('[TaskServer] LOG: OpenRouter SDK initialized successfully.')
  } catch (sdkError) {
    console.error(
      '[TaskServer] CRITICAL ERROR initializing OpenRouter SDK:',
      sdkError
    )
  }
} else if (GEMINI_API_KEY) {
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
  }
} else {
  // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
  console.error(
    '[TaskServer] WARNING: Neither OPENROUTER_API_KEY nor GEMINI_API_KEY environment variable is set. API calls will fail.'
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
  effort: z.enum(['low', 'medium', 'high']).optional(),
  parentTaskId: z.string().uuid().optional(),
})
const TaskListSchema = z.array(TaskSchema)
type Task = z.infer<typeof TaskSchema>

// --- Helper Functions ---

async function readTasks(): Promise<Task[]> {
  // (User's implementation preserved)
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
  // (User's implementation preserved)
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
  // Basic parsing
  if (!responseText) {
    return []
  }

  // Split by newlines and clean up
  const lines = responseText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.match(/^[-*+]\s*$/))

  // Process each line to remove markdown list markers and numbering
  const cleanedLines = lines.map((line) => {
    // Remove markdown list markers and numbering
    return line
      .replace(/^[-*+]\s*/, '') // Remove list markers like -, *, +
      .replace(/^\d+\.\s*/, '') // Remove numbered list markers like 1. 2. etc.
      .replace(/^[a-z]\)\s*/i, '') // Remove lettered list markers like a) b) etc.
      .replace(/^\([a-z]\)\s*/i, '') // Remove lettered list markers like (a) (b) etc.
  })

  // Detect hierarchical structure based on indentation or subtask indicators
  const tasks: string[] = []
  let currentParentTask: string | null = null

  for (const line of cleanedLines) {
    // Check if this is a parent task or a subtask based on various indicators
    const isSubtask =
      line.match(/subtask|sub-task/i) || // Contains "subtask" or "sub-task"
      line.startsWith('  ') || // Has leading indentation
      line.match(/^[a-z]\.[\d]+/i) || // Contains notation like "a.1"
      line.includes('→') || // Contains arrow indicators
      line.match(/\([a-z]\)/i) // Contains notation like "(a)"

    if (isSubtask && currentParentTask) {
      // If it's a subtask and we have a parent, tag it with the parent task info
      tasks.push(line)
    } else {
      // This is a new parent task
      currentParentTask = line
      tasks.push(line)
    }
  }

  return tasks
}

/**
 * Extracts the text content from an AI API result.
 * Handles both OpenRouter and Gemini responses.
 */
function extractTextFromResponse(
  result:
    | GenerateContentResult
    | OpenAI.Chat.Completions.ChatCompletion
    | undefined
): string | null {
  // For OpenRouter responses
  if (
    result &&
    'choices' in result &&
    result.choices &&
    result.choices.length > 0
  ) {
    const choice = result.choices[0]
    if (choice.message && choice.message.content) {
      return choice.message.content
    }
    return null
  }

  // For Gemini responses
  if (result && 'response' in result) {
    try {
      const response = result.response
      if (response.promptFeedback?.blockReason) {
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
      console.error(
        '[TaskServer] No text content found in Gemini response candidate.'
      )
      return null
    } catch (error) {
      console.error(
        '[TaskServer] Error extracting text from Gemini response:',
        error
      )
      return null
    }
  }

  return null
}

/**
 * Determines task effort using an LLM.
 * Works with both OpenRouter and Gemini models.
 */
async function determineTaskEffort(
  description: string,
  model: GenerativeModel | OpenAI | null
): Promise<'low' | 'medium' | 'high'> {
  if (!model) {
    console.error('[TaskServer] Cannot determine effort: No model provided.')
    // Default to medium effort if no model is available
    return 'medium' // Changed default to medium
  }

  const prompt = `
Task: ${description}

Analyze this **coding task** and determine its estimated **effort level** based ONLY on the implementation work involved. A higher effort level often implies the task might need breaking down into sub-steps. Use these criteria:
- Low: Simple code changes likely contained in one or a few files, minimal logic changes, straightforward bug fixes. (e.g., renaming a variable, adding a console log, simple UI text change). Expected to be quick.
- Medium: Requires moderate development time, involves changes across several files or components with clear patterns, includes writing new functions or small classes, moderate refactoring. Might benefit from 1-3 sub-steps. (e.g., adding a new simple API endpoint, implementing a small feature).
- High: Involves significant development time, potentially spanning multiple days. Suggests complex architectural changes, intricate algorithm implementation, deep refactoring affecting multiple core components, requires careful design and likely needs breakdown into multiple sub-steps (3+). (e.g., redesigning a core system, implementing complex data processing).

Exclude factors like testing procedures, documentation, deployment, or project management overhead.

Provide ONLY ONE of these words as your answer: "low", "medium", or "high".
`

  try {
    let result
    if (model instanceof OpenAI) {
      // Use OpenRouter
      result = await model.chat.completions.create({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 10,
      })
    } else {
      // Use Gemini
      result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 10,
        },
        safetySettings,
      })
    }

    const resultText = extractTextFromResponse(result)

    if (resultText) {
      const lowerText = resultText.toLowerCase().trim()
      if (lowerText.includes('low')) return 'low'
      if (lowerText.includes('medium')) return 'medium'
      if (lowerText.includes('high')) return 'high'
    }

    // Default to medium if we couldn't determine
    console.warn(
      `[TaskServer] Could not determine effort for "${description.substring(
        0,
        50
      )}...", defaulting to medium. LLM response: ${resultText}`
    )
    return 'medium' // Changed default to medium
  } catch (error) {
    console.error('[TaskServer] Error determining task effort:', error)
    return 'medium' // Default to medium on error
  }
}

/**
 * Interface for a parent-child task relationship
 */
interface TaskRelationship {
  parentId: string
  parentDescription: string
  childIds: string[]
}

/**
 * Options for task breakdown
 */
interface BreakdownOptions {
  minSubtasks?: number
  maxSubtasks?: number
  preferredEffort?: 'low' | 'medium'
}

/**
 * Breaks down a high-effort task into subtasks using an LLM.
 * Works with both OpenRouter and Gemini models.
 */
async function breakDownHighEffortTask(
  taskDescription: string,
  parentId: string,
  model: GenerativeModel | OpenAI | null,
  options: BreakdownOptions = {}
): Promise<string[]> {
  if (!model) {
    console.error('[TaskServer] Cannot break down task: No model provided.')
    return []
  }

  // Use provided options or defaults
  const {
    minSubtasks = 2,
    maxSubtasks = 5,
    preferredEffort = 'medium',
  } = options

  // Message for tasks
  const breakdownPrompt = `
Break down this high-effort **coding task** into a list of smaller, sequential, actionable coding subtasks:\n"${taskDescription}"\n\nGuidelines:\n1. Create ${minSubtasks}-${maxSubtasks} subtasks.\n2. Each subtask should ideally be 'low' or 'medium' effort, focusing on a specific part of the implementation.\n3. Make each subtask a concrete coding action (e.g., "Create function X", "Refactor module Y", "Add field Z to interface").\n4. The subtasks should represent a logical sequence for implementation.\n5. **Only include the list of coding subtasks** (numbered 1, 2, 3, etc.). Do NOT include explanations, introductions, non-coding steps like testing, deployment, or documentation.\n`

  try {
    let breakdownResult
    if (model instanceof OpenAI) {
      // Use OpenRouter
      breakdownResult = await model.chat.completions.create({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: breakdownPrompt }],
        temperature: 0.5,
      })
    } else {
      // Use Gemini
      breakdownResult = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: breakdownPrompt }] }],
        generationConfig: {
          temperature: 0.5,
        },
        safetySettings,
      })
    }

    const breakdownText = extractTextFromResponse(breakdownResult)

    if (!breakdownText) {
      console.error('[TaskServer] No valid breakdown text received from LLM.')
      return []
    }

    // Split text by newlines, clean up, and filter out items that don't look like tasks
    const subtasks = breakdownText
      .split('\n')
      .map((line) => {
        // Remove numbering and leading/trailing whitespace
        return line.replace(/^[\d]+[\.\)]-?\s*/, '').trim()
      })
      .filter(
        (line) =>
          // Filter out any empty lines or lines that don't look like tasks
          line &&
          line.length > 10 &&
          !line.match(/^(subtasks|steps|breakdown|tasks|here)/i)
      )

    return subtasks
  } catch (error) {
    console.error('[TaskServer] Error breaking down high-effort task:', error)
    return []
  }
}

/**
 * Extracts parent task ID from a task description if present.
 * @param taskDescription The task description to check
 * @returns An object with the cleaned description and parentTaskId if found
 */
function extractParentTaskId(taskDescription: string): {
  description: string
  parentTaskId?: string
} {
  const parentTaskMatch = taskDescription.match(/\[parentTask:([a-f0-9-]+)\]$/i)

  if (parentTaskMatch) {
    // Extract the parent task ID
    const parentTaskId = parentTaskMatch[1]
    // Remove the parent task tag from the description
    const description = taskDescription.replace(
      /\s*\[parentTask:[a-f0-9-]+\]$/i,
      ''
    )
    return { description, parentTaskId }
  }

  return { description: taskDescription }
}

/**
 * Extracts effort rating from a task description.
 * @param taskDescription The task description to check
 * @returns An object with the cleaned description and effort
 */
function extractEffort(taskDescription: string): {
  description: string
  effort: 'low' | 'medium' | 'high'
} {
  const effortMatch = taskDescription.match(/^\[(low|medium|high)\]/i)

  if (effortMatch) {
    const effort = effortMatch[1].toLowerCase() as 'low' | 'medium' | 'high'
    // Remove the effort tag from the description
    const description = taskDescription.replace(
      /^\[(low|medium|high)\]\s*/i,
      ''
    )
    return { description, effort }
  }

  // Default to medium if no effort found
  return { description: taskDescription, effort: 'medium' }
}

// --- MCP Server Setup ---
console.error('[TaskServer] LOG: Setting up MCP Server instance...')
const server = new McpServer({
  name: 'task-manager-mcp',
  version: '0.6.3', // Incremented patch version
  description:
    'MCP Server using Google AI SDK and repomix for planning and review.',
  // CORRECTED: Capabilities should only declare support, not define tools here.
  capabilities: {
    tools: { listChanged: false },
    // resources: {}, // Add later if needed
    // prompts: {}, // Add later if needed
  },
})
console.error('[TaskServer] LOG: MCP Server instance created.')

// --- Tool Definitions ---
console.error('[TaskServer] LOG: Defining tools...')

// 1. Tool: get_next_task
server.tool(
  'get_next_task', // name
  {}, // inputSchema shape (empty object for no input)
  // handler - input type inferred, return type defines output structure
  async ({}) => {
    await logToFile('[TaskServer] Handling get_next_task request...')
    const tasks = await readTasks()
    const pendingTasks = tasks.filter((task) => task.status === 'pending')

    if (pendingTasks.length === 0) {
      await logToFile('[TaskServer] No pending tasks found.')
      return {
        content: [{ type: 'text', text: 'No pending tasks found.' }],
      }
    }

    // Prioritize tasks based on hierarchy and effort
    let nextTask: Task | undefined = undefined

    // First, check if there are any tasks without parent dependencies (top-level tasks)
    const topLevelTasks = pendingTasks.filter((task) => !task.parentTaskId)

    if (topLevelTasks.length > 0) {
      // Prioritize lower effort tasks first at the top level
      const simpleTasks = topLevelTasks.filter((task) => task.effort === 'low')
      if (simpleTasks.length > 0) {
        nextTask = simpleTasks[0]
      } else {
        // If no simple tasks, take the first medium one or high if no medium exists
        const mediumTasks = topLevelTasks.filter(
          (task) => task.effort === 'medium'
        )
        if (mediumTasks.length > 0) {
          nextTask = mediumTasks[0]
        } else {
          nextTask = topLevelTasks[0] // Default to the first top-level task
        }
      }
    } else {
      // If no top-level tasks remain, check for subtasks
      // First identify all parent tasks that are completed
      const completedParentIds = new Set(
        tasks
          .filter((task) => task.status === 'completed')
          .map((task) => task.id)
      )

      // Find subtasks whose parent is completed
      const availableSubtasks = pendingTasks.filter(
        (task) => task.parentTaskId && completedParentIds.has(task.parentTaskId)
      )

      if (availableSubtasks.length > 0) {
        // Prioritize by effort for subtasks too
        const simpleSubtasks = availableSubtasks.filter(
          (task) => task.effort === 'low'
        )
        if (simpleSubtasks.length > 0) {
          nextTask = simpleSubtasks[0]
        } else {
          const mediumSubtasks = availableSubtasks.filter(
            (task) => task.effort === 'medium'
          )
          if (mediumSubtasks.length > 0) {
            nextTask = mediumSubtasks[0]
          } else {
            nextTask = availableSubtasks[0] // Default to the first available subtask
          }
        }
      } else {
        // As a fallback, just get the first pending task
        nextTask = pendingTasks[0]
      }
    }

    // We now have the next task to work on
    await logToFile(`[TaskServer] Found next task: ${nextTask.id}`)

    // Include effort in the message if available
    const effortInfo = nextTask.effort ? ` (Effort: ${nextTask.effort})` : ''

    // Include parent info if this is a subtask
    let parentInfo = ''
    if (nextTask.parentTaskId) {
      const parentTask = tasks.find((t) => t.id === nextTask!.parentTaskId)
      if (parentTask) {
        const parentDesc =
          parentTask.description.length > 30
            ? parentTask.description.substring(0, 30) + '...'
            : parentTask.description
        parentInfo = ` (Subtask of: "${parentDesc}")`
      }
    }

    // Embed ID, description, effort, and parent info in the text message
    const message = `Next pending task (ID: ${nextTask.id})${effortInfo}${parentInfo}: ${nextTask.description}`

    return {
      content: [{ type: 'text', text: message }],
    }
  }
)

// 2. Tool: mark_task_complete
server.tool(
  'mark_task_complete', // name
  {
    // inputSchema shape
    task_id: z.string().uuid({ message: 'Valid task ID (UUID) is required.' }),
  },
  // handler - input type inferred ({task_id}), return type defines output structure
  async ({ task_id }) => {
    await logToFile(
      `[TaskServer] Handling mark_task_complete request for ID: ${task_id}`
    )
    const tasks = await readTasks()
    let taskFound = false
    let alreadyCompleted = false
    let isSubtask = false
    let parentTaskId: string | undefined = undefined

    // CORRECTED: Removed unnecessary Promise.all, map is synchronous here.
    const updatedTasks = tasks.map((task) => {
      if (task.id === task_id) {
        taskFound = true
        if (task.status === 'completed') {
          // Use console.error directly here as logToFile is async and might complicate flow
          console.error(`[TaskServer] Task ${task_id} already completed.`)
          alreadyCompleted = true
        }
        if (task.parentTaskId) {
          isSubtask = true
          parentTaskId = task.parentTaskId
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
      return { content: [{ type: 'text', text: message }], isError }
    } else if (alreadyCompleted) {
      message = `Task ${task_id} was already marked as complete.`
    } else {
      // Check if this is a subtask and if all sibling subtasks are now complete
      if (isSubtask && parentTaskId) {
        // Get all subtasks for this parent
        const siblingTasks = updatedTasks.filter(
          (task) => task.parentTaskId === parentTaskId
        )
        const allSubtasksComplete = siblingTasks.every(
          (task) => task.status === 'completed'
        )

        if (allSubtasksComplete) {
          // Auto-complete the parent task
          const finalTasks = updatedTasks.map((task) => {
            if (task.id === parentTaskId) {
              console.error(
                `[TaskServer] Auto-completing parent task ${parentTaskId} as all subtasks are complete.`
              )
              return { ...task, status: 'completed' as const }
            }
            return task
          })

          await writeTasks(finalTasks)
          await logToFile(
            `[TaskServer] Task ${task_id} and parent task marked as complete.`
          )
          message = `Task ${task_id} marked as complete. Parent task ${parentTaskId} also auto-completed as all subtasks are now complete.`
          return { content: [{ type: 'text', text: message }] }
        }
      }

      // Pass the correctly mapped array directly
      await writeTasks(updatedTasks)
      await logToFile(`[TaskServer] Task ${task_id} marked as complete.`)
      message = `Task ${task_id} marked as complete.`
    }
    // FIXED: Return structure matching SDK examples { content: [...], isError?: boolean }
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
    // inputSchema shape
    feature_description: z.string().min(10, {
      message: 'Feature description must be at least 10 characters.',
    }),
    project_path: z
      .string()
      .describe(
        'The absolute path to the project directory to scan with repomix. Defaults to current directory if omitted.'
      ),
  },
  // handler - input type inferred ({feature_description, project_path}), return type defines output structure
  async ({ feature_description, project_path }) => {
    await logToFile(
      `[TaskServer] Handling plan_feature request: "${feature_description}" (Path: ${
        project_path || 'CWD'
      })`
    )

    let message: string
    let isError = false
    let task_count: number | undefined = undefined

    if (!planningModel && !openRouter) {
      await logToFile(
        '[TaskServer] Planning model not initialized (check API key).'
      )
      message = 'Error: Planning model not initialized. Check API Key.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let codebaseContext = ''
    try {
      const targetDir = project_path || '.'
      const command = `npx repomix ${targetDir} --style plain` // Add target directory to command

      // Use console.error for synchronous-like logging before async operation
      console.error(`[TaskServer] Running repomix command: ${command}`)
      await logToFile(`[TaskServer] Running repomix command: ${command}`)

      const { stdout, stderr } = await execPromise(command, {
        maxBuffer: 10 * 1024 * 1024, // Increased buffer size
      })

      if (stderr) {
        await logToFile(`[TaskServer] repomix stderr: ${stderr}`)
        if (stderr.includes('Permission denied')) {
          message = `Error running repomix: Permission denied scanning directory '${targetDir}'. Check folder permissions.`
          isError = true
          return { content: [{ type: 'text', text: message }], isError }
        }
      }
      if (!stdout) {
        await logToFile('[TaskServer] repomix stdout was empty.')
      }
      // read repomix-output.txt
      const repomixOutput = await fs.readFile(
        path.join(targetDir, 'repomix-output.txt'),
        'utf-8'
      )
      if (!repomixOutput) {
        await logToFile('[TaskServer] repomix-output.txt was empty.')
      }
      codebaseContext = repomixOutput
      await logToFile(
        `[TaskServer] repomix context gathered (${codebaseContext.length} chars) for path: ${targetDir}.`
      )
    } catch (error: any) {
      await logToFile(`[TaskServer] Error running repomix: ${error}`)
      let errorMessage = 'Error running repomix to gather codebase context.'
      if (error.message && error.message.includes('command not found')) {
        errorMessage =
          "Error: 'npx' or 'repomix' command not found. Make sure Node.js and repomix are installed and in the PATH."
      } else if (error.stderr && error.stderr.includes('Permission denied')) {
        errorMessage = `Error running repomix: Permission denied scanning directory. Check folder permissions.`
      }
      message = errorMessage
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let planSteps: string[] = []
    let highEffortTasks: string[] = []
    let complexTaskMap = new Map<string, string>()

    try {
      await logToFile('[TaskServer] Calling LLM API for planning...')
      const prompt = `Based on the following codebase context:\n\`\`\`\n${codebaseContext}\n\`\`\`\n\nGenerate a detailed, step-by-step **coding implementation plan** for the feature: \"${feature_description}\".\n\nThe plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.\n\nFor each **coding task**, you MUST include an **effort rating** (low, medium, or high) in square brackets at the beginning of each task description, based on implementation work involved. High effort tasks often require breakdown. Example: \"[medium] Refactor the user authentication module\".\n\nUse these effort definitions:\n- Low: Simple, quick changes in one or few files, minimal logic changes.\n- Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes. Might need 1-3 sub-steps.\n- High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring. Likely needs multiple sub-steps (3+).\n\nProvide each coding task as a separate item on a new line. Do not use markdown list markers (like -, *, +). Ensure the plan is sequential where applicable.`
      const MAX_PROMPT_LENGTH = Infinity // Removing truncation for now
      const truncatedPrompt =
        prompt.length > MAX_PROMPT_LENGTH
          ? prompt.substring(0, MAX_PROMPT_LENGTH) + '\n\n[CONTEXT TRUNCATED]'
          : prompt
      if (prompt.length > MAX_PROMPT_LENGTH) {
        console.warn(
          // Keep console.warn for developer visibility
          `[TaskServer] WARNING: Prompt truncated to ${MAX_PROMPT_LENGTH} characters for LLM API.`
        )
      }

      const result = await (openRouter
        ? openRouter.chat.completions.create({
            model: OPENROUTER_MODEL,
            messages: [{ role: 'user', content: truncatedPrompt }],
            temperature: 0.7,
          })
        : planningModel?.generateContent({
            contents: [{ role: 'user', parts: [{ text: truncatedPrompt }] }],
            safetySettings,
          }))

      const responseText = extractTextFromResponse(result)

      if (responseText === null) {
        message =
          'Error: Failed to get planning response from LLM or response was blocked.'
        isError = true
        return { content: [{ type: 'text', text: message }], isError }
      }

      planSteps = parseGeminiPlanResponse(responseText)
      await logToFile(
        `[TaskServer] Received plan with ${planSteps.length} steps from LLM.`
      )

      // Verify and fix effort ratings for each task
      const tasksWithoutEffort = planSteps.filter(
        (step) => !step.match(/^\[(low|medium|high)\]/i)
      )

      if (tasksWithoutEffort.length > 0) {
        await logToFile(
          `[TaskServer] Found ${tasksWithoutEffort.length} tasks without effort ratings. Determining effort...`
        )

        // Process each task without effort rating
        const updatedTasks: string[] = []

        for (const task of planSteps) {
          if (task.match(/^\[(low|medium|high)\]/i)) {
            // Task already has effort rating
            updatedTasks.push(task)
          } else {
            // Determine effort for this task
            try {
              const effort = await determineTaskEffort(
                task,
                openRouter || planningModel || null
              )
              updatedTasks.push(`[${effort}] ${task}`)
              // await logToFile( // Reduce log noise slightly
              //   `[TaskServer] Assigned effort \'${effort}\' to task: \"${task.substring(
              //     0,
              //     40
              //   )}...\"`
              // )
            } catch (error) {
              // If effort determination fails, default to medium
              updatedTasks.push(`[medium] ${task}`)
              console.error(
                `[TaskServer] Error determining effort for task \"${task.substring(
                  0,
                  40
                )}...":`,
                error
              )
            }
          }
        }

        // Replace original tasks with effort-rated ones
        planSteps = updatedTasks
        await logToFile(
          `[TaskServer] Successfully added effort ratings to all tasks.`
        )
      }

      // Process high-effort tasks recursively
      highEffortTasks = []
      const tasksToKeep: string[] = [] // Tasks that are not high effort or failed breakdown
      complexTaskMap = new Map<string, string>() // Use the existing map

      for (const step of planSteps) {
        const effortMatch = step.match(/^\[(low|medium|high)\]/i)
        if (effortMatch && effortMatch[1].toLowerCase() === 'high') {
          highEffortTasks.push(step)
        } else {
          tasksToKeep.push(step) // Keep low and medium tasks
        }
      }

      // Store parent task IDs for later use with subtasks
      const parentTaskIds = new Map<string, string>()
      let breakdownSuccesses = 0
      let breakdownFailures = 0
      const allSubtasks: string[] = [] // Collect all generated subtasks

      for (const complexTask of highEffortTasks) {
        const taskDescription = complexTask.replace(/^\[high\]\s*/i, '')
        // Generate a UUID for this parent task
        const parentId = crypto.randomUUID()
        // Store the mapping of the *original* high-effort task description to its ID
        complexTaskMap.set(taskDescription, parentId) // Map description to ID for potential use

        // Use the helper function to break down high-effort tasks
        const subtasks = await breakDownHighEffortTask(
          taskDescription,
          parentId, // Pass parentId for context if needed by the function internally, though the prompt doesn't explicitly use it
          openRouter || planningModel || null,
          {
            minSubtasks: 2, // Adjusted min/max
            maxSubtasks: 5,
            preferredEffort: 'medium', // Target medium effort subtasks
          }
        )

        if (subtasks.length > 0) {
          // Add subtasks, explicitly tagging them with the parent ID
          const subtasksWithParentId = subtasks.map((subtaskDesc) => {
            // Re-evaluate effort for subtasks or assign default
            const { description: cleanSubDesc, effort: subEffort } =
              extractEffort(subtaskDesc)
            // If effort wasn't assigned by breakdown, determine it or default
            const finalEffort = ['low', 'medium', 'high'].includes(subEffort)
              ? subEffort
              : 'medium' // Default to medium if breakdown didn't provide valid one
            return `[${finalEffort}] ${cleanSubDesc} [parentTask:${parentId}]` // Append parent ID tag
          })
          allSubtasks.push(...subtasksWithParentId)

          // Add the original high-level task back but mark it as completed automatically,
          // serving as a parent container
          tasksToKeep.push(`${complexTask} [parentContainer]`) // Add a marker to identify this later

          breakdownSuccesses++
        } else {
          // Keep the original high-effort task if breakdown fails
          tasksToKeep.push(complexTask)
          breakdownFailures++
        }
      }

      // Combine the kept tasks and the new subtasks
      planSteps = [...tasksToKeep, ...allSubtasks]

      await logToFile(
        `[TaskServer] Final plan processing: ${tasksToKeep.length} kept/parent tasks, ${allSubtasks.length} new subtasks (${breakdownSuccesses} successful breakdowns, ${breakdownFailures} failures)`
      )
    } catch (error) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error('[TaskServer] Error calling LLM planning API:', error)
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

    const newTasks: Task[] = planSteps.map((step) => {
      // Use helper functions to extract effort and parent task ID
      const isParentContainer = step.includes('[parentContainer]')
      const descriptionWithTags = step.replace('[parentContainer]', '').trim() // Remove container tag

      const { description: descWithoutParent, parentTaskId } =
        extractParentTaskId(descriptionWithTags) // Extracts [parentTask:...]
      const { description: cleanDescription, effort } =
        extractEffort(descWithoutParent) // Extracts [effort]...

      return {
        id: complexTaskMap.get(cleanDescription) || crypto.randomUUID(), // Use mapped ID for parent, else new UUID
        status: isParentContainer ? 'completed' : 'pending', // Mark containers as completed
        description: cleanDescription,
        effort: effort,
        ...(parentTaskId && { parentTaskId }), // Add parentTaskId if extracted
      }
    })
    try {
      await logToFile('[TaskServer] Saving new task plan...')
      let existingTasks: Task[] = []

      try {
        existingTasks = await readTasks()
      } catch (readError) {
        await logToFile(
          `[TaskServer] Error reading existing tasks: ${readError}. Starting with empty task list.`
        )
        existingTasks = []
      }

      const completedTasks = existingTasks.filter(
        (task) => task.status === 'completed'
      )

      // Ensure no ID collisions between new tasks and existing completed tasks
      const existingIds = new Set(completedTasks.map((task) => task.id))
      let idCollisions = 0

      // Regenerate any IDs that collide with existing tasks
      newTasks.forEach((task) => {
        let collisionCount = 0
        // Ensure the parent container tasks get their specific ID if it exists in the map
        const parentContainerDesc = task.description // Use description before potential modification
        const mappedParentId = complexTaskMap.get(parentContainerDesc)

        if (task.status === 'completed' && mappedParentId) {
          // This is a parent container
          task.id = mappedParentId
        } else if (task.parentTaskId && !existingIds.has(task.parentTaskId)) {
          // Check if parent ID exists before assigning it
          const parentTaskExists =
            newTasks.some((t) => t.id === task.parentTaskId) ||
            completedTasks.some((t) => t.id === task.parentTaskId)
          if (!parentTaskExists) {
            console.warn(
              `[TaskServer] Subtask '${task.description.substring(
                0,
                30
              )}...' references non-existent parent ID ${
                task.parentTaskId
              }. Removing reference.`
            )
            task.parentTaskId = undefined // Remove invalid parent ID
          }
        }

        // Handle potential collisions for newly generated IDs
        while (task.status === 'pending' && existingIds.has(task.id)) {
          // Only check pending tasks for collisions
          console.error(
            `[TaskServer] Task ID collision detected for pending task, regenerating ID...`
          )
          collisionCount++
          task.id = crypto.randomUUID()

          // Safeguard against infinite loops (though extremely unlikely)
          if (collisionCount > 5) {
            console.error(
              `[TaskServer] Multiple ID collisions encountered (${collisionCount}). Check UUID generation.`
            )
            break
          }
        }

        if (collisionCount > 0) {
          idCollisions += collisionCount
        }

        // Add this ID to our set to avoid collisions between new tasks too
        existingIds.add(task.id)
      })

      if (idCollisions > 0) {
        await logToFile(
          `[TaskServer] Resolved ${idCollisions} ID collisions when creating new tasks.`
        )
      }

      // Ensure parent-child relationships reference valid tasks AFTER ID generation/collision checks
      newTasks.forEach((task) => {
        // Double check parent references after potential ID regeneration
        if (task.parentTaskId && !existingIds.has(task.parentTaskId)) {
          const parentTaskExists =
            newTasks.some((t) => t.id === task.parentTaskId) ||
            completedTasks.some((t) => t.id === task.parentTaskId)
          if (!parentTaskExists) {
            console.warn(
              `[TaskServer] Task '${task.description.substring(
                0,
                30
              )}...' has invalid parentTaskId (${
                task.parentTaskId
              }) after collision checks, removing reference.`
            )
            task.parentTaskId = undefined
          }
        }
      })

      const finalTaskList = [...completedTasks, ...newTasks]

      try {
        await writeTasks(finalTaskList)
        task_count = newTasks.length
        await logToFile(`[TaskServer] New plan saved with ${task_count} tasks.`)
        message = `Successfully generated plan with ${task_count} tasks for feature: "${feature_description}"`
      } catch (writeError) {
        await logToFile(
          `[TaskServer] Error writing tasks to file: ${writeError}`
        )
        message =
          'Error saving the generated task plan: Task file could not be written.'
        isError = true
      }

      // FIXED: Return structure
      return { content: [{ type: 'text', text: message }], isError }
    } catch (error) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error('[TaskServer] Error saving the new task plan:', error)
      message = 'Error saving the generated task plan.'
      isError = true
      // FIXED: Return structure
      return { content: [{ type: 'text', text: message }], isError }
    }
  }
)

// 4. Tool: review_changes
server.tool(
  'review_changes', // name
  {}, // inputSchema shape (empty object for no input)
  // handler - input type inferred, return type defines output structure
  async ({}) => {
    await logToFile('[TaskServer] Handling review_changes request...')

    let message: string
    let isError = false

    if (!reviewModel && !openRouter) {
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
        // FIXED: Return structure
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
      // FIXED: Return structure
      return { content: [{ type: 'text', text: message }], isError }
    }

    let reviewFeedback = ''
    try {
      await logToFile('[TaskServer] Calling Gemini API for review analysis...')
      const prompt = `Review the following code changes (git diff):\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\nProvide concise feedback on correctness, potential issues, style violations, and areas for refactoring. Structure your feedback clearly.`

      const result = await (openRouter
        ? openRouter.chat.completions.create({
            model: OPENROUTER_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.5,
          })
        : reviewModel?.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            safetySettings,
          }))

      const responseText = extractTextFromResponse(result)

      if (responseText === null) {
        message =
          'Error: Failed to get review response from LLM or response was blocked.'
        isError = true
      } else {
        reviewFeedback = responseText
        message = reviewFeedback // The review itself is the message
        await logToFile('[TaskServer] Received review feedback from Gemini.')
      }
      // FIXED: Return structure
      return { content: [{ type: 'text', text: message }], isError }
    } catch (error) {
      // Reverted from await logToFile due to potential top-level await issues/reliability in error handlers
      console.error('[TaskServer] Error calling Gemini review API:', error)
      message = 'Error occurred during review analysis API call.'
      isError = true
      // FIXED: Return structure
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
  await logToFile('[TaskServer] LOG: Checking API Keys...')

  // Enhanced initialization check
  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY && !genAI && !openRouter) {
    await logToFile(
      '[TaskServer] FATAL: Neither OPENROUTER_API_KEY nor GEMINI_API_KEY environment variable is set. Exiting.'
    )
    process.exit(1)
  } else if (!genAI && !openRouter && (OPENROUTER_API_KEY || GEMINI_API_KEY)) {
    await logToFile(
      '[TaskServer] Attempting to initialize AI SDK with environment variables...'
    )

    // Try to initialize OpenRouter first
    if (OPENROUTER_API_KEY) {
      try {
        openRouter = new OpenAI({
          apiKey: OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api/v1',
        })
        await logToFile('[TaskServer] OpenRouter SDK initialized successfully.')
      } catch (error) {
        await logToFile(
          '[TaskServer] Error initializing OpenRouter SDK:' + error
        )
      }
    }

    // Fall back to Gemini if OpenRouter fails or isn't available
    if (!openRouter && GEMINI_API_KEY) {
      try {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
        // Re-initialize models if genAI was just created
        planningModel = genAI.getGenerativeModel({
          model: GEMINI_MODEL,
        })
        reviewModel = genAI.getGenerativeModel({
          model: GEMINI_MODEL,
        })
        await logToFile(
          '[TaskServer] Google AI SDK initialized using dotenv in main.'
        )
      } catch (sdkError) {
        await logToFile(
          '[TaskServer] CRITICAL ERROR initializing Google AI SDK in main:' +
            sdkError
        )
        process.exit(1)
      }
    } else if (!openRouter && !genAI) {
      // This case means no API was successfully initialized
      await logToFile(
        '[TaskServer] FATAL: Could not initialize any AI SDK (API Keys likely invalid). Exiting.'
      )
      process.exit(1)
    }
  }
  await logToFile('[TaskServer] LOG: API Keys checked/SDKs Initialized.')

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
  // Use synchronous append for critical errors before exit
  try {
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
  // Cannot reliably use async logToFile here
  console.error(
    '[TaskServer] FATAL: Unhandled Rejection at:',
    promise,
    'reason:',
    reason
  )
  // Use synchronous append for critical errors before exit
  try {
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

// Cannot reliably use async logToFile here
console.error(
  '[TaskServer] LOG: Script execution reaching end of top-level code.'
) // Log before main() call
main().catch((error) => {
  // Cannot reliably use async logToFile here
  console.error('[TaskServer] CRITICAL ERROR executing main():', error)
  // Use synchronous append for critical errors before exit
  try {
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
