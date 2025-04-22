import { GenerateContentResult, GenerativeModel } from '@google/generative-ai'
import OpenAI from 'openai'
import crypto from 'crypto'
import {
  BreakdownOptions,
  EffortEstimationSchema,
  TaskBreakdownSchema,
  TaskBreakdownResponseSchema,
  Task,
  TaskListSchema,
  HistoryEntry,
  FeatureHistorySchema,
  TaskSchema,
  LLMClarificationRequestSchema,
} from '../models/types'
import { aiService } from '../services/aiService'
import { logToFile } from './logger'
import { safetySettings, OPENROUTER_MODEL, GEMINI_MODEL } from '../config'
import { z } from 'zod'
import { encoding_for_model } from 'tiktoken'
import { addHistoryEntry } from './dbUtils'
import webSocketService from '../services/webSocketService'
import { databaseService } from '../services/databaseService'

/**
 * Parses the text response from Gemini into a list of tasks.
 */
export function parseGeminiPlanResponse(
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
 * Determines task effort using an LLM.
 * Uses structured JSON output for consistent results.
 * Works with both OpenRouter and Gemini models.
 */
export async function determineTaskEffort(
  description: string,
  model: GenerativeModel | OpenAI | null
): Promise<'low' | 'medium' | 'high'> {
  if (!model) {
    console.error('[TaskServer] Cannot determine effort: No model provided.')
    // Default to medium effort if no model is available
    return 'medium'
  }

  const prompt = `
Task: ${description}

Analyze this **coding task** and determine its estimated **effort level** based ONLY on the implementation work involved. A higher effort level often implies the task might need breaking down into sub-steps. Use these criteria:
- Low: Simple code changes likely contained in one or a few files, minimal logic changes, straightforward bug fixes. (e.g., renaming a variable, adding a console log, simple UI text change). Expected to be quick.
- Medium: Requires moderate development time, involves changes across several files or components with clear patterns, includes writing new functions or small classes, moderate refactoring. Might benefit from 1-3 sub-steps. (e.g., adding a new simple API endpoint, implementing a small feature).
- High: Involves significant development time, potentially spanning multiple days. Suggests complex architectural changes, intricate algorithm implementation, deep refactoring affecting multiple core components, requires careful design and likely needs breakdown into multiple sub-steps (3+). (e.g., redesigning a core system, implementing complex data processing).

Exclude factors like testing procedures, documentation, deployment, or project management overhead.

Respond with a JSON object that includes the effort level and optionally a short reasoning.
`

  try {
    // Use structured response with schema validation
    if (model instanceof OpenAI) {
      // Use OpenRouter with structured output
      const result = await aiService.callOpenRouterWithSchema(
        OPENROUTER_MODEL,
        [{ role: 'user', content: prompt }],
        EffortEstimationSchema,
        { temperature: 0.1, max_tokens: 100 }
      )

      if (result.success) {
        return result.data.effort
      } else {
        console.warn(
          `[TaskServer] Could not determine effort using structured output: ${result.error}. Defaulting to medium.`
        )
        return 'medium'
      }
    } else {
      // Use Gemini with structured output
      const result = await aiService.callGeminiWithSchema(
        GEMINI_MODEL,
        prompt,
        EffortEstimationSchema,
        { temperature: 0.1, maxOutputTokens: 100 }
      )

      if (result.success) {
        return result.data.effort
      } else {
        console.warn(
          `[TaskServer] Could not determine effort using structured output: ${result.error}. Defaulting to medium.`
        )
        return 'medium'
      }
    }
  } catch (error) {
    console.error('[TaskServer] Error determining task effort:', error)
    return 'medium' // Default to medium on error
  }
}

/**
 * Breaks down a high-effort task into subtasks using an LLM.
 * Uses structured JSON output for consistent results.
 * Works with both OpenRouter and Gemini models.
 */
export async function breakDownHighEffortTask(
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
Break down this high-effort **coding task** into a list of smaller, sequential, actionable coding subtasks:

Task: "${taskDescription}"

Guidelines:
1. Create ${minSubtasks}-${maxSubtasks} subtasks.
2. Each subtask should ideally be '${preferredEffort}' effort, focusing on a specific part of the implementation.
3. Make each subtask a concrete coding action (e.g., "Create function X", "Refactor module Y", "Add field Z to interface").
4. The subtasks should represent a logical sequence for implementation.
5. Only include coding tasks, not testing, documentation, or deployment steps.

**IMPORTANT: Respond ONLY with a valid JSON object.** The object MUST have a single key named "subtasks". The value of "subtasks" MUST be an array of JSON objects, where each object represents a subtask and has the following keys:
  - "description": (string) The description of the subtask.
  - "effort": (string) The estimated effort level, MUST be either "low" or "medium".

**Example of the exact required output format:**
{
  "subtasks": [
    { "description": "Subtask 1 description", "effort": "medium" },
    { "description": "Subtask 2 description", "effort": "low" }
  ]
}

Do NOT include any other text, markdown formatting, or explanations outside of this JSON object.
`

  try {
    // Use structured response with schema validation
    if (model instanceof OpenAI) {
      // Use OpenRouter with structured output
      const result = await aiService.callOpenRouterWithSchema(
        OPENROUTER_MODEL,
        [{ role: 'user', content: breakdownPrompt }],
        TaskBreakdownResponseSchema,
        { temperature: 0.5 }
      )

      if (result.success) {
        // Extract the descriptions from the structured response
        return result.data.subtasks.map(
          (subtask) => `[${subtask.effort}] ${subtask.description}`
        )
      } else {
        console.warn(
          `[TaskServer] Could not break down task using structured output: ${result.error}`
        )
        return []
      }
    } else {
      // Use Gemini with structured output
      const result = await aiService.callGeminiWithSchema(
        GEMINI_MODEL,
        breakdownPrompt,
        TaskBreakdownResponseSchema,
        { temperature: 0.5 }
      )

      if (result.success) {
        // Extract the descriptions from the structured response
        return result.data.subtasks.map(
          (subtask) => `[${subtask.effort}] ${subtask.description}`
        )
      } else {
        console.warn(
          `[TaskServer] Could not break down task using structured output: ${result.error}`
        )
        return []
      }
    }
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
export function extractParentTaskId(taskDescription: string): {
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
export function extractEffort(taskDescription: string): {
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

/**
 * Parses and validates a JSON response string against a provided Zod schema.
 *
 * @param responseText - The raw JSON string from the LLM response
 * @param schema - The Zod schema to validate against
 * @returns An object containing either the validated data or error information
 */
export function parseAndValidateJsonResponse<T extends z.ZodType>(
  responseText: string | null | undefined,
  schema: T
):
  | { success: true; data: z.infer<T> }
  | { success: false; error: string; rawData: any | null } {
  // Handle null or empty responses
  if (!responseText) {
    return {
      success: false,
      error: 'Response text is empty or null',
      rawData: null,
    }
  }

  // Extract JSON from the response if it's wrapped in markdown or other text
  let jsonString = responseText

  // Look for JSON in markdown code blocks
  const jsonBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    jsonString = jsonBlockMatch[1]
  }

  // Attempt to parse the JSON
  let parsedData: any
  try {
    parsedData = JSON.parse(jsonString)
  } catch (parseError) {
    return {
      success: false,
      error: `Failed to parse JSON: ${(parseError as Error).message}`,
      rawData: responseText,
    }
  }

  // Validate against the schema
  const validationResult = schema.safeParse(parsedData)

  if (validationResult.success) {
    return {
      success: true,
      data: validationResult.data,
    }
  } else {
    // Format Zod errors into a more readable string
    const formattedErrors = validationResult.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join('; ')

    return {
      success: false,
      error: `Schema validation failed: ${formattedErrors}`,
      rawData: parsedData,
    }
  }
}

/**
 * Ensures all task descriptions have an effort rating prefix.
 * Determines effort using an LLM if missing.
 */
export async function ensureEffortRatings(
  taskDescriptions: string[],
  model: GenerativeModel | OpenAI | null
): Promise<string[]> {
  const effortRatedTasks: string[] = []
  for (const taskDesc of taskDescriptions) {
    const effortMatch = taskDesc.match(/^\[(low|medium|high)\]/i)
    if (effortMatch) {
      // Ensure consistent casing
      const effort = effortMatch[1].toLowerCase() as 'low' | 'medium' | 'high'
      const cleanDesc = taskDesc.replace(/^\[(low|medium|high)\]\s*/i, '')
      effortRatedTasks.push(`[${effort}] ${cleanDesc}`)
    } else {
      let effort: 'low' | 'medium' | 'high' = 'medium' // Default effort
      try {
        if (model) {
          // Only call if model is available
          effort = await determineTaskEffort(taskDesc, model)
        }
      } catch (error) {
        console.error(
          `[TaskServer] Error determining effort for task "${taskDesc.substring(
            0,
            40
          )}...". Defaulting to medium:`,
          error
        )
      }
      effortRatedTasks.push(`[${effort}] ${taskDesc}`)
    }
  }
  return effortRatedTasks
}

/**
 * Processes tasks: breaks down high-effort ones, ensures effort, and creates Task objects.
 */
export async function processAndBreakdownTasks(
  initialTasksWithEffort: string[],
  model: GenerativeModel | OpenAI | null,
  featureId: string
): Promise<{ finalTasks: Task[]; complexTaskMap: Map<string, string> }> {
  const finalProcessedSteps: string[] = []
  const complexTaskMap = new Map<string, string>()
  let breakdownSuccesses = 0
  let breakdownFailures = 0

  for (const step of initialTasksWithEffort) {
    const effortMatch = step.match(/^\[(low|medium|high)\]/i)
    const isHighEffort = effortMatch && effortMatch[1].toLowerCase() === 'high'

    if (isHighEffort) {
      const taskDescription = step.replace(/^\[high\]\s*/i, '')
      const parentId = crypto.randomUUID()
      complexTaskMap.set(taskDescription, parentId) // Map original description to ID

      try {
        await addHistoryEntry(featureId, 'model', {
          step: 'task_breakdown_attempt',
          task: step,
          parentId,
        })

        const subtasks = await breakDownHighEffortTask(
          taskDescription,
          parentId,
          model,
          { minSubtasks: 2, maxSubtasks: 5, preferredEffort: 'medium' }
        )

        if (subtasks.length > 0) {
          // Add parent container task (marked completed later)
          finalProcessedSteps.push(`${step} [parentContainer]`) // Add marker

          // Process and add subtasks immediately after parent
          // Ensure subtasks also have effort ratings
          const subtasksWithEffort = await ensureEffortRatings(subtasks, model)
          const subtasksWithParentId = subtasksWithEffort.map((subtaskDesc) => {
            const { description: cleanSubDesc } = extractEffort(subtaskDesc) // Already has effort
            return `${subtaskDesc} [parentTask:${parentId}]`
          })

          finalProcessedSteps.push(...subtasksWithParentId)

          await addHistoryEntry(featureId, 'model', {
            step: 'task_breakdown_success',
            task: step,
            parentId,
            subtasks: subtasksWithParentId,
          })
          breakdownSuccesses++
        } else {
          // Breakdown failed, keep original high-effort task
          finalProcessedSteps.push(step)
          await addHistoryEntry(featureId, 'model', {
            step: 'task_breakdown_failure',
            task: step,
          })
          breakdownFailures++
        }
      } catch (breakdownError) {
        console.error(
          `[TaskServer] Error during breakdown for task "${taskDescription.substring(
            0,
            40
          )}...":`,
          breakdownError
        )
        finalProcessedSteps.push(step) // Keep original task on error
        await addHistoryEntry(featureId, 'model', {
          step: 'task_breakdown_error',
          task: step,
          error:
            breakdownError instanceof Error
              ? breakdownError.message
              : String(breakdownError),
        })
        breakdownFailures++
      }
    } else {
      // Keep low/medium effort tasks as is
      finalProcessedSteps.push(step)
    }
  }

  await logToFile(
    `[TaskServer] Breakdown processing complete: ${breakdownSuccesses} successes, ${breakdownFailures} failures.`
  )

  // --- Create Task Objects ---
  const finalTasks: Task[] = []
  const taskCreationErrors: string[] = []

  for (const step of finalProcessedSteps) {
    try {
      const isParentContainer = step.includes('[parentContainer]')
      const descriptionWithTags = step.replace('[parentContainer]', '').trim()

      const { description: descWithoutParent, parentTaskId } =
        extractParentTaskId(descriptionWithTags)
      const { description: cleanDescription, effort } =
        extractEffort(descWithoutParent)

      // Validate effort extracted or default
      const validatedEffort = ['low', 'medium', 'high'].includes(effort)
        ? effort
        : 'medium'

      // Get the predetermined ID for parent containers, otherwise generate new
      const originalHighEffortDesc = isParentContainer ? cleanDescription : null

      const taskId =
        (originalHighEffortDesc &&
          complexTaskMap.get(originalHighEffortDesc)) ||
        crypto.randomUUID()

      // If it's a parent container, set status to 'decomposed', otherwise 'pending'
      const status = isParentContainer ? 'decomposed' : 'pending'

      const taskData = {
        id: taskId,
        feature_id: featureId,
        status,
        description: cleanDescription,
        effort: validatedEffort,
        // Decomposed tasks are not considered 'completed' in the traditional sense
        completed: false,
        ...(parentTaskId && { parentTaskId }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // --- Enhanced Logging ---
      logToFile(
        `[processAndBreakdownTasks] Preparing ${
          isParentContainer ? 'Parent' : parentTaskId ? 'Subtask' : 'Task'
        } for validation: ID=${taskId}, Status=${status}, Parent=${
          parentTaskId || 'N/A'
        }, Desc="${cleanDescription.substring(0, 50)}..."`
      )
      logToFile(
        `[processAndBreakdownTasks] Task data before validation: ${JSON.stringify(
          taskData
        )}`
      )
      // --- End Enhanced Logging ---

      // Validate against the Task schema before pushing
      const validationResult = TaskSchema.safeParse(taskData)
      if (validationResult.success) {
        // --- Enhanced Logging ---
        logToFile(
          `[processAndBreakdownTasks] Validation successful for Task ID: ${taskId}`
        )
        // --- End Enhanced Logging ---
        finalTasks.push(validationResult.data)
      } else {
        // --- Enhanced Logging ---
        const errorMsg = `Task "${cleanDescription.substring(
          0,
          30
        )}..." (ID: ${taskId}) failed validation: ${
          validationResult.error.message
        }`
        logToFile(`[processAndBreakdownTasks] ${errorMsg}`)
        // --- End Enhanced Logging ---
        taskCreationErrors.push(errorMsg)
        console.warn(
          `[TaskServer] Task validation failed for "${cleanDescription.substring(
            0,
            30
          )}..." (ID: ${taskId}):`,
          validationResult.error.flatten()
        )
      }
    } catch (creationError) {
      const errorMsg = `Error creating task object for step "${step.substring(
        0,
        30
      )}...": ${
        creationError instanceof Error
          ? creationError.message
          : String(creationError)
      }`
      // --- Enhanced Logging ---
      logToFile(`[processAndBreakdownTasks] ${errorMsg}`)
      // --- End Enhanced Logging ---
      taskCreationErrors.push(errorMsg)
      console.error(
        `[TaskServer] Error creating task object for step "${step.substring(
          0,
          30
        )}...":`,
        creationError
      )
    }
  }

  if (taskCreationErrors.length > 0) {
    console.error(
      `[TaskServer] ${taskCreationErrors.length} errors occurred during task object creation/validation.`
    )
    await addHistoryEntry(featureId, 'model', {
      step: 'task_creation_errors',
      errors: taskCreationErrors,
    })
    // Decide if we should throw or return partial results. Returning for now.
  }

  return { finalTasks, complexTaskMap }
}

/**
 * Processes raw plan steps, ensures effort ratings are assigned, breaks down high-effort tasks,
 * saves the final task list, and notifies WebSocket clients of the update.
 *
 * @param rawPlanSteps Array of task descriptions (format: "[effort] description").
 * @param model The generative model to use for effort estimation/task breakdown.
 * @param featureId The ID of the feature being planned.
 * @param fromReview Optional flag to set fromReview: true on all saved tasks.
 * @returns The final list of processed Task objects.
 */
export async function processAndFinalizePlan(
  rawPlanSteps: string[],
  model: GenerativeModel | OpenAI | null,
  featureId: string,
  fromReview: boolean = false // Add default value
): Promise<Task[]> {
  logToFile(
    `[TaskServer] Processing and finalizing plan for feature ${featureId}...`
  )
  let existingTasks: Task[] = []
  let finalTasks: Task[] = []
  const complexTaskMap = new Map<string, string>() // To track original description of broken down tasks

  try {
    // 1. Ensure all raw steps have effort ratings
    const initialTasksWithEffort = await ensureEffortRatings(
      rawPlanSteps,
      model
    )

    // 2. Process tasks: Breakdown high-effort ones
    const { finalTasks: processedTasks, complexTaskMap: breakdownMap } =
      await processAndBreakdownTasks(
        initialTasksWithEffort,
        model,
        featureId // Pass featureId for logging/history
      )

    // Merge complexTaskMap from breakdown
    breakdownMap.forEach((value, key) => complexTaskMap.set(key, value))

    // --- Start Database Operations ---
    await databaseService.connect()
    logToFile(
      `[processAndFinalizePlan] Database connected. Fetching existing tasks...`
    )

    // 3. Fetch existing tasks to compare
    existingTasks = await databaseService.getTasksByFeatureId(featureId)

    const existingTaskMap = new Map(existingTasks.map((t) => [t.id, t]))
    const processedTaskMap = new Map(processedTasks.map((t) => [t.id, t]))
    const tasksToAdd: Task[] = []
    const tasksToUpdate: { id: string; updates: Partial<Task> }[] = []
    const taskIdsToDelete: string[] = []

    // 4. Compare processed tasks with existing tasks
    for (const processedTask of processedTasks) {
      if (existingTaskMap.has(processedTask.id)) {
        // Task exists, check for updates
        const existing = existingTaskMap.get(processedTask.id)!
        // updates object should only contain keys matching DB columns (snake_case)
        const updates: Partial<
          Pick<Task, 'description' | 'effort' | 'fromReview'> & {
            parentTaskId?: string
          }
        > = {}
        if (existing.description !== processedTask.description) {
          updates.description = processedTask.description
        }
        if (existing.effort !== processedTask.effort) {
          updates.effort = processedTask.effort
        }
        // Compare snake_case from DB (existing) with camelCase from processed Task
        if (existing.parentTaskId !== processedTask.parentTaskId) {
          // Add snake_case key to updates object for DB
          updates.parentTaskId = processedTask.parentTaskId
        }
        // Always update the 'fromReview' flag if this process is from review
        if (fromReview && !existing.fromReview) {
          // Use camelCase here as Task type expects it, DB service handles conversion to snake_case
          updates.fromReview = true
        }

        // Check if any updates are needed using the keys in the updates object
        if (Object.keys(updates).length > 0) {
          tasksToUpdate.push({ id: processedTask.id, updates })
        }
      } else {
        // New task to add
        tasksToAdd.push(processedTask)
      }
    }

    // Identify tasks to delete (exist in DB but not in new plan)
    for (const existingTask of existingTasks) {
      if (!processedTaskMap.has(existingTask.id)) {
        taskIdsToDelete.push(existingTask.id)
      }
    }

    // 5. Apply changes to the database
    logToFile(
      `[processAndFinalizePlan] Applying DB changes: ${tasksToAdd.length} adds, ${tasksToUpdate.length} updates, ${taskIdsToDelete.length} deletes.`
    )
    for (const { id, updates } of tasksToUpdate) {
      // Check if the task being updated was decomposed
      const isDecomposed = complexTaskMap.has(id)
      if (isDecomposed) {
        // If decomposed, mark status as 'decomposed' and completed = true
        await databaseService.updateTaskStatus(id, 'decomposed', true)
        // Only update other details if necessary (rare for decomposed tasks)
        if (Object.keys(updates).length > 0) {
          // Pass updates object (contains snake_case key) to DB service
          await databaseService.updateTaskDetails(id, updates)
        }
      } else {
        // Otherwise, just update details
        // Pass updates object (contains snake_case key) to DB service
        await databaseService.updateTaskDetails(id, updates)
      }
    }

    for (const task of tasksToAdd) {
      // Ensure parent task exists if specified using camelCase from Task type
      if (task.parentTaskId) {
        const parentExistsInDB = existingTaskMap.has(task.parentTaskId)
        const parentExistsInProcessed = processedTaskMap.has(task.parentTaskId)

        if (!parentExistsInDB && !parentExistsInProcessed) {
          logToFile(
            `[processAndFinalizePlan] Warning: Parent task ${task.parentTaskId} for task ${task.id} not found. Setting parent to null.`
          )
          // Use camelCase when modifying the task object
          task.parentTaskId = undefined
        }
      }

      // Prepare object for DB insertion with snake_case keys
      const now = Math.floor(Date.now() / 1000)
      const dbTaskPayload: any = {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        completed: task.completed ? 1 : 0,
        effort: task.effort,
        feature_id: featureId,
        created_at:
          task.createdAt && typeof task.createdAt === 'number'
            ? Math.floor(new Date(task.createdAt * 1000).getTime() / 1000)
            : now, // Map and convert
        updated_at:
          task.updatedAt && typeof task.updatedAt === 'number'
            ? Math.floor(new Date(task.updatedAt * 1000).getTime() / 1000)
            : now, // Map and convert
        from_review: fromReview || task.fromReview ? 1 : 0, // Convert camelCase to snake_case for DB
      }

      // Only add parent_task_id if it exists and is not null
      if (task.parentTaskId !== null && task.parentTaskId !== undefined) {
        dbTaskPayload.parent_task_id = task.parentTaskId
      }

      await databaseService.addTask(dbTaskPayload)
    }

    for (const taskId of taskIdsToDelete) {
      await databaseService.deleteTask(taskId)
    }

    // 6. Fetch the final list of tasks after all modifications
    finalTasks = await databaseService.getTasksByFeatureId(featureId)

    logToFile(
      `[processAndFinalizePlan] Final task count for feature ${featureId}: ${finalTasks.length}`
    )
    // --- End Database Operations ---
  } catch (error) {
    logToFile(
      `[processAndFinalizePlan] Error during plan finalization for feature ${featureId}: ${error}`
    )
    console.error(`[TaskServer] Error during plan finalization:`, error)
    // Re-throw the error to be handled by the caller (e.g., tool handler)
    throw error
  } finally {
    // Ensure database connection is closed, even if errors occurred
    try {
      await databaseService.close()
      logToFile(`[processAndFinalizePlan] Database connection closed.`)
    } catch (closeError) {
      logToFile(
        `[processAndFinalizePlan] Error closing database connection: ${closeError}`
      )
      console.error(`[TaskServer] Error closing database:`, closeError)
    }
  }

  // 7. Notify UI about the updated tasks (outside the main try/catch for DB ops)
  try {
    const formattedTasks = finalTasks.map((task) => ({
      // Basic formatting for WS
      id: task.id,
      description: task.description,
      status: task.status,
      effort: task.effort,
      // Map snake_case from DB task to camelCase for WebSocket payload
      parentTaskId: task.parentTaskId,
      completed: task.completed, // DB Service already converts this to boolean
      title: task.title,
      // Map snake_case timestamps from DB to ISO strings for WebSocket payload
      createdAt:
        task.createdAt && typeof task.createdAt === 'number'
          ? new Date(task.createdAt * 1000).toISOString()
          : undefined,
      updatedAt:
        task.updatedAt && typeof task.updatedAt === 'number'
          ? new Date(task.updatedAt * 1000).toISOString()
          : undefined,
    }))
    webSocketService.notifyTasksUpdated(featureId, formattedTasks)
    logToFile(`[processAndFinalizePlan] WebSocket notification sent.`)
  } catch (wsError) {
    logToFile(
      `[processAndFinalizePlan] Error sending WebSocket notification: ${wsError}`
    )
    console.error(`[TaskServer] Error sending WebSocket update:`, wsError)
    // Do not re-throw WS errors, as the main operation succeeded
  }

  return finalTasks
}

/**
 * Detects if the LLM response contains a clarification request.
 * This function searches for both JSON-formatted clarification requests and
 * special prefix format like [CLARIFICATION_NEEDED].
 *
 * @param responseText The raw response from the LLM
 * @returns An object with success flag and either the parsed clarification request or error message
 */
export function detectClarificationRequest(
  responseText: string | null | undefined
):
  | {
      detected: true
      clarificationRequest: z.infer<typeof LLMClarificationRequestSchema>
      rawResponse: string
    }
  | { detected: false; rawResponse: string | null } {
  if (!responseText) {
    return { detected: false, rawResponse: null }
  }

  // Check for [CLARIFICATION_NEEDED] format
  const prefixMatch = responseText.match(
    /\[CLARIFICATION_NEEDED\](.*?)(\[END_CLARIFICATION\]|$)/s
  )
  if (prefixMatch) {
    const questionText = prefixMatch[1].trim()

    // Parse out options if they exist
    const optionsMatch = questionText.match(/Options:\s*\[(.*?)\]/)
    const options = optionsMatch
      ? optionsMatch[1].split(',').map((o) => o.trim())
      : undefined

    // Check if text input is allowed
    const allowsText = !questionText.includes('MULTIPLE_CHOICE_ONLY')

    // Create a clarification request object
    return {
      detected: true,
      clarificationRequest: {
        type: 'clarification_needed',
        question: questionText
          .replace(/Options:\s*\[.*?\]/, '')
          .replace('MULTIPLE_CHOICE_ONLY', '')
          .trim(),
        options,
        allowsText,
      },
      rawResponse: responseText,
    }
  }

  // Try to parse as JSON
  try {
    // Check if we have a JSON object in the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const jsonStr = jsonMatch[0]
      const parsedJson = JSON.parse(jsonStr)

      // Check if it's a clarification request
      if (
        parsedJson.type === 'clarification_needed' ||
        parsedJson.clarification_needed ||
        parsedJson.needs_clarification
      ) {
        // Attempt to validate against our schema
        const result = LLMClarificationRequestSchema.safeParse({
          type: 'clarification_needed',
          question: parsedJson.question || parsedJson.message || '',
          options: parsedJson.options || undefined,
          allowsText: parsedJson.allowsText !== false,
        })

        if (result.success) {
          return {
            detected: true,
            clarificationRequest: result.data,
            rawResponse: responseText,
          }
        }
      }
    }

    return { detected: false, rawResponse: responseText }
  } catch (error) {
    // If JSON parsing fails, it's not a JSON-formatted clarification request
    return { detected: false, rawResponse: responseText }
  }
}
