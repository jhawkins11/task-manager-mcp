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
} from '../models/types'
import { aiService } from '../services/aiService'
import { logToFile } from './logger'
import { safetySettings, OPENROUTER_MODEL, GEMINI_MODEL } from '../config'
import { z } from 'zod'
import { encoding_for_model } from 'tiktoken'
import { addHistoryEntry } from './fsUtils'

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

Respond with a JSON object containing an array of subtasks, each with a description and effort level.
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
      // Note: The complexTaskMap uses the *original* high-effort description before breakdown
      const originalHighEffortDesc = isParentContainer
        ? cleanDescription // The cleanDescription of a parent container *is* the original high-effort desc
        : null

      const taskId =
        (originalHighEffortDesc &&
          complexTaskMap.get(originalHighEffortDesc)) ||
        crypto.randomUUID()

      const status = isParentContainer ? 'completed' : 'pending'

      const taskData = {
        id: taskId,
        feature_id: featureId,
        status,
        description: cleanDescription,
        effort: validatedEffort,
        completed: status === 'completed',
        ...(parentTaskId && { parentTaskId }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // Validate against the Task schema before pushing
      const validationResult = TaskSchema.safeParse(taskData)
      if (validationResult.success) {
        finalTasks.push(validationResult.data)
      } else {
        taskCreationErrors.push(
          `Task "${cleanDescription.substring(0, 30)}..." failed validation: ${
            validationResult.error.message
          }`
        )
        console.warn(
          `[TaskServer] Task validation failed for "${cleanDescription.substring(
            0,
            30
          )}...":`,
          validationResult.error.flatten()
        )
      }
    } catch (creationError) {
      taskCreationErrors.push(
        `Error creating task object for step "${step.substring(0, 30)}...": ${
          creationError instanceof Error
            ? creationError.message
            : String(creationError)
        }`
      )
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
