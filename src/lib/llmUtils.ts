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
    maxRetries = 3,
  } = options

  // Enhanced prompt with clearer instructions for JSON output
  const breakdownPrompt = `
I need to break down this high-effort coding task into smaller, actionable subtasks:

Task: "${taskDescription}"

Guidelines:
1. Create ${minSubtasks}-${maxSubtasks} subtasks.
2. Each subtask should ideally be '${preferredEffort}' effort, focusing on a specific part of the implementation.
3. Make each subtask a concrete coding action (e.g., "Create function X", "Refactor module Y", "Add field Z to interface").
4. The subtasks should represent a logical sequence for implementation.
5. Only include coding tasks, not testing, documentation, or deployment steps.

IMPORTANT RESPONSE FORMAT INSTRUCTIONS:
- Return ONLY a valid JSON object
- The JSON object MUST have a single key named "subtasks"
- "subtasks" MUST be an array of objects with exactly two fields each:
  - "description": string - The subtask description
  - "effort": string - MUST be either "low" or "medium"
- No other text before or after the JSON object
- No markdown formatting, code blocks, or comments

Example of EXACTLY how your response should be formatted:
{
  "subtasks": [
    {
      "description": "Create the database schema for user profiles",
      "effort": "medium"
    },
    {
      "description": "Implement the user profile repository class",
      "effort": "medium"
    }
  ]
}
`

  // Function to handle the actual API call with retry logic
  async function attemptBreakdown(attempt: number): Promise<string[]> {
    try {
      // Use structured response with schema validation
      if (model instanceof OpenAI) {
        // Use OpenRouter with structured output
        const result = await aiService.callOpenRouterWithSchema(
          OPENROUTER_MODEL,
          [{ role: 'user', content: breakdownPrompt }],
          TaskBreakdownResponseSchema,
          { temperature: 0.2 } // Lower temperature for more consistent output
        )

        if (result.success) {
          // Extract the descriptions from the structured response
          return result.data.subtasks.map(
            (subtask) => `[${subtask.effort}] ${subtask.description}`
          )
        } else {
          console.warn(
            `[TaskServer] Could not break down task using structured output (attempt ${attempt}): ${result.error}`
          )

          // Retry if attempts remain
          if (attempt < maxRetries) {
            logToFile(
              `[TaskServer] Retrying task breakdown (attempt ${attempt + 1})`
            )
            return attemptBreakdown(attempt + 1)
          }
          return []
        }
      } else {
        // Use Gemini with structured output
        const result = await aiService.callGeminiWithSchema(
          GEMINI_MODEL,
          breakdownPrompt,
          TaskBreakdownResponseSchema,
          { temperature: 0.2 } // Lower temperature for more consistent output
        )

        if (result.success) {
          // Extract the descriptions from the structured response
          return result.data.subtasks.map(
            (subtask) => `[${subtask.effort}] ${subtask.description}`
          )
        } else {
          console.warn(
            `[TaskServer] Could not break down task using structured output (attempt ${attempt}): ${result.error}`
          )

          // Retry if attempts remain
          if (attempt < maxRetries) {
            logToFile(
              `[TaskServer] Retrying task breakdown (attempt ${attempt + 1})`
            )
            return attemptBreakdown(attempt + 1)
          }
          return []
        }
      }
    } catch (error) {
      console.error(
        `[TaskServer] Error breaking down high-effort task (attempt ${attempt}):`,
        error
      )

      // Retry if attempts remain
      if (attempt < maxRetries) {
        logToFile(
          `[TaskServer] Retrying task breakdown after error (attempt ${
            attempt + 1
          })`
        )
        return attemptBreakdown(attempt + 1)
      }
      return []
    }
  }

  // Start the breakdown process with first attempt
  return attemptBreakdown(1)
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
 * A more robust approach to parsing LLM-generated JSON that might be malformed due to newlines
 * or other common issues in AI responses.
 */
function robustJsonParse(text: string): any {
  // First attempt: Try with standard JSON.parse
  try {
    return JSON.parse(text)
  } catch (error: any) {
    // If standard parsing fails, try more aggressive fixing
    logToFile(
      `[robustJsonParse] Standard parsing failed, attempting recovery: ${error}`
    )

    try {
      // Detect the main expected structure type (tasks vs subtasks)
      const isTasksArray = text.includes('"tasks"')
      const isSubtasksArray = text.includes('"subtasks"')
      const hasDescription = text.includes('"description"')
      const hasEffort = text.includes('"effort"')

      // Special handling for common OpenRouter/AI model response patterns
      if ((isTasksArray || isSubtasksArray) && hasDescription && hasEffort) {
        const arrayKey = isSubtasksArray ? 'subtasks' : 'tasks'

        // 1. Enhanced regex that works for both tasks and subtasks arrays
        const taskRegex =
          /"description"\s*:\s*"((?:[^"\\]|\\"|\\|[\s\S])*?)"\s*,\s*"effort"\s*:\s*"(low|medium|high)"/g
        const tasks = []
        let match

        while ((match = taskRegex.exec(text)) !== null) {
          try {
            if (match[1] && match[2]) {
              tasks.push({
                description: match[1].replace(/\\"/g, '"'),
                effort: match[2],
              })
            }
          } catch (innerError) {
            logToFile(`[robustJsonParse] Error extracting task: ${innerError}`)
          }
        }

        if (tasks.length > 0) {
          logToFile(
            `[robustJsonParse] Successfully extracted ${tasks.length} ${arrayKey} with regex`
          )
          return { [arrayKey]: tasks }
        }

        // 2. If regex extraction fails, try extracting JSON objects directly
        if (tasks.length === 0) {
          try {
            const objectsExtracted = extractJSONObjects(text)
            if (objectsExtracted.length > 0) {
              // Filter valid task objects
              const validTasks = objectsExtracted.filter(
                (obj) =>
                  obj &&
                  typeof obj === 'object' &&
                  obj.description &&
                  obj.effort &&
                  typeof obj.description === 'string' &&
                  typeof obj.effort === 'string'
              )

              if (validTasks.length > 0) {
                logToFile(
                  `[robustJsonParse] Successfully extracted ${validTasks.length} ${arrayKey} with object extraction`
                )
                return { [arrayKey]: validTasks }
              }
            }
          } catch (objExtractionError) {
            logToFile(
              `[robustJsonParse] Object extraction failed: ${objExtractionError}`
            )
          }
        }
      }

      // 3. Fall back to manual line-by-line parsing for JSON objects
      const lines = text.split('\n')
      let cleanJson = ''
      let inString = false

      for (const line of lines) {
        let processedLine = line

        // Count quote marks to track if we're inside a string
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '"' && (i === 0 || line[i - 1] !== '\\')) {
            inString = !inString
          }
        }

        // Add a space instead of newline if we're in the middle of a string
        cleanJson += inString ? ' ' + processedLine : processedLine
      }

      // 4. Balance braces and brackets if needed
      cleanJson = balanceBracesAndBrackets(cleanJson)

      // Final attempt to parse the cleaned JSON
      return JSON.parse(cleanJson)
    } catch (recoveryError) {
      logToFile(
        `[robustJsonParse] All recovery attempts failed: ${recoveryError}`
      )
      throw new Error(`Failed to parse JSON: ${error.message}`)
    }
  }
}

/**
 * Extracts valid JSON objects from a potentially malformed string.
 * Helps recover objects from truncated or malformed JSON.
 */
function extractJSONObjects(text: string): any[] {
  const objects: any[] = []

  // First try to find array boundaries
  const arrayStartIndex = text.indexOf('[')
  const arrayEndIndex = text.lastIndexOf(']')

  if (arrayStartIndex !== -1 && arrayEndIndex > arrayStartIndex) {
    // Extract array content
    const arrayContent = text.substring(arrayStartIndex + 1, arrayEndIndex)

    // Split by potential object boundaries, respecting nested objects
    let depth = 0
    let currentObject = ''
    let inString = false

    for (let i = 0; i < arrayContent.length; i++) {
      const char = arrayContent[i]

      // Track string boundaries
      if (char === '"' && (i === 0 || arrayContent[i - 1] !== '\\')) {
        inString = !inString
      }

      // Only track structure when not in a string
      if (!inString) {
        if (char === '{') {
          depth++
          if (depth === 1) {
            // Start of a new object
            currentObject = '{'
            continue
          }
        } else if (char === '}') {
          depth--
          if (depth === 0) {
            // End of an object, try to parse it
            currentObject += '}'
            try {
              const obj = JSON.parse(currentObject)
              objects.push(obj)
            } catch (e) {
              // If this object can't be parsed, just continue
            }
            currentObject = ''
            continue
          }
        } else if (char === ',' && depth === 0) {
          // Skip commas between objects
          continue
        }
      }

      // Add character to current object if we're inside one
      if (depth > 0) {
        currentObject += char
      }
    }
  }

  return objects
}

/**
 * Balances braces and brackets in a JSON string to make it valid
 */
function balanceBracesAndBrackets(text: string): string {
  let result = text

  // Count opening and closing braces/brackets
  const openBraces = (result.match(/\{/g) || []).length
  const closeBraces = (result.match(/\}/g) || []).length
  const openBrackets = (result.match(/\[/g) || []).length
  const closeBrackets = (result.match(/\]/g) || []).length

  // Add missing closing braces/brackets
  if (openBraces > closeBraces) {
    result += '}'.repeat(openBraces - closeBraces)
  }

  if (openBrackets > closeBrackets) {
    result += ']'.repeat(openBrackets - closeBrackets)
  }

  return result
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

  // Enhanced logging for debugging
  try {
    logToFile(
      `[parseAndValidateJsonResponse] Raw response text: ${responseText?.substring(
        0,
        1000
      )}`
    )
  } catch (logError) {
    // Ignore logging errors
  }

  // Extract JSON from the response if it's wrapped in markdown or other text
  let jsonString = responseText

  // Look for JSON in markdown code blocks
  const jsonBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    jsonString = jsonBlockMatch[1]
  }

  // --- Additional cleaning: extract first valid JSON object from text ---
  function extractJsonFromText(text: string): string {
    // Remove markdown code fences
    text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '')
    // Find the first { and last }
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return text.substring(firstBrace, lastBrace + 1)
    }
    return text.trim()
  }
  jsonString = extractJsonFromText(jsonString)

  // Try to identify expected content type for better recovery
  const expectsSubtasks =
    responseText.includes('"subtasks"') || responseText.includes('subtasks')

  const expectsTasks =
    responseText.includes('"tasks"') || responseText.includes('tasks')

  // --- Auto-fix common JSON issues (trailing commas, comments) ---
  function fixCommonJsonIssues(text: string): string {
    // Remove JavaScript-style comments
    text = text.replace(/\/\/.*$/gm, '')
    text = text.replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove trailing commas in objects and arrays
    text = text.replace(/,\s*([}\]])/g, '$1')

    // Fix broken newlines in the middle of strings
    text = text.replace(/([^\\])"\s*\n\s*"/g, '$1')

    // Normalize string values that got broken across lines
    text = text.replace(/([^\\])"\s*\n\s*([^"])/g, '$1", "$2')

    // Fix incomplete JSON objects
    const openBraces = (text.match(/\{/g) || []).length
    const closeBraces = (text.match(/\}/g) || []).length
    if (openBraces > closeBraces) {
      text = text + '}'.repeat(openBraces - closeBraces)
    }

    // Fix unclosed quotes at end of string
    if ((text.match(/"/g) || []).length % 2 !== 0) {
      // Check if the last quote is an opening quote (likely in the middle of a string)
      const lastQuotePos = text.lastIndexOf('"')
      const endsWithOpenQuote =
        lastQuotePos !== -1 &&
        text.substring(lastQuotePos).split('"').length === 2

      if (endsWithOpenQuote) {
        text = text + '"'
      }
    }

    return text
  }
  jsonString = fixCommonJsonIssues(jsonString)
  // --- End auto-fix ---

  try {
    logToFile(
      `[parseAndValidateJsonResponse] Cleaned JSON string: ${jsonString?.substring(
        0,
        1000
      )}`
    )
  } catch (logError) {
    // Ignore logging errors
  }

  // Attempt to parse the JSON using robust parser
  let parsedData: any
  try {
    parsedData = robustJsonParse(jsonString)
    logToFile(
      `[parseAndValidateJsonResponse] JSON parsed successfully with robust parser`
    )
  } catch (parseError) {
    // If primary parsing failed, try reconstructing specific expected structures
    try {
      // For tasks/subtasks, try to reconstruct using direct object extraction
      if (expectsTasks || expectsSubtasks) {
        const arrayKey = expectsSubtasks ? 'subtasks' : 'tasks'

        // Extract task objects directly from text
        const extractedObjects = extractJSONObjects(jsonString)
        if (extractedObjects.length > 0) {
          // Filter out invalid objects
          const validItems = extractedObjects.filter(
            (obj) =>
              obj &&
              typeof obj === 'object' &&
              obj.description &&
              obj.effort &&
              typeof obj.description === 'string' &&
              typeof obj.effort === 'string'
          )

          if (validItems.length > 0) {
            parsedData = { [arrayKey]: validItems }
            logToFile(
              `[parseAndValidateJsonResponse] Successfully reconstructed ${arrayKey} array with ${validItems.length} items`
            )

            // Validate against schema immediately
            const validationResult = schema.safeParse(parsedData)
            if (validationResult.success) {
              return {
                success: true,
                data: validationResult.data,
              }
            }
          }
        }

        // If we can see where tasks are, try regex extraction
        const regex = new RegExp(
          `"(description|desc|name)"\\s*:\\s*"([^"]*)"[\\s\\S]*?"(effort|difficulty)"\\s*:\\s*"(low|medium|high)"`,
          'gi'
        )

        const items = []
        let match
        while ((match = regex.exec(responseText)) !== null) {
          try {
            items.push({
              description: match[2],
              effort: match[4].toLowerCase(),
            })
          } catch (e) {
            // Skip invalid matches
          }
        }

        if (items.length > 0) {
          parsedData = { [arrayKey]: items }
          logToFile(
            `[parseAndValidateJsonResponse] Successfully extracted ${items.length} ${arrayKey} with regex`
          )

          // Validate against schema
          const validationResult = schema.safeParse(parsedData)
          if (validationResult.success) {
            return {
              success: true,
              data: validationResult.data,
            }
          }
        }
      }
    } catch (reconstructionError) {
      logToFile(
        `[parseAndValidateJsonResponse] Reconstruction error: ${reconstructionError}`
      )
      // Continue to normal error handling
    }

    // All parsing methods have failed
    logToFile(
      `[parseAndValidateJsonResponse] All parsing attempts failed: ${parseError}`
    )
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
    logToFile(
      `[parseAndValidateJsonResponse] Schema validation failed. Errors: ${JSON.stringify(
        validationResult.error.errors
      )}`
    )

    // Attempt to recover partial valid data
    const recoveredData = attemptPartialResponseRecovery(parsedData, schema)
    if (recoveredData) {
      logToFile(
        `[parseAndValidateJsonResponse] Successfully recovered partial response`
      )
      return {
        success: true,
        data: recoveredData,
      }
    }

    return {
      success: false,
      error: `Schema validation failed: ${validationResult.error.message}`,
      rawData: parsedData,
    }
  }
}

/**
 * Attempts to recover partial valid data from a failed schema validation.
 * Particularly useful for array of tasks or subtasks where some items might be valid.
 */
function attemptPartialResponseRecovery(
  parsedData: any,
  schema: z.ZodType
): any | null {
  try {
    logToFile(
      `[attemptPartialResponseRecovery] Attempting to recover partial valid response`
    )

    // Handle common case: tasks array with valid and invalid items
    if (
      parsedData &&
      ((parsedData.tasks && Array.isArray(parsedData.tasks)) ||
        (parsedData.subtasks && Array.isArray(parsedData.subtasks)))
    ) {
      const isSubtasksArray =
        parsedData.subtasks && Array.isArray(parsedData.subtasks)
      const arrayKey = isSubtasksArray ? 'subtasks' : 'tasks'
      const items = isSubtasksArray ? parsedData.subtasks : parsedData.tasks

      // Filter out invalid task items
      const validItems = items.filter(
        (item: any) =>
          item &&
          typeof item === 'object' &&
          item.description &&
          item.effort &&
          typeof item.description === 'string' &&
          typeof item.effort === 'string'
      )

      if (validItems.length > 0) {
        const recoveredData = { ...parsedData, [arrayKey]: validItems }
        const validationResult = schema.safeParse(recoveredData)

        if (validationResult.success) {
          logToFile(
            `[attemptPartialResponseRecovery] Recovery successful, found ${validItems.length} valid ${arrayKey}`
          )
          return validationResult.data
        }
      }
    }

    return null
  } catch (error) {
    logToFile(
      `[attemptPartialResponseRecovery] Recovery attempt failed: ${error}`
    )
    return null
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
  featureId: string,
  fromReviewContext: boolean
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

      const taskDataToValidate: Omit<
        Task,
        'title' | 'subTasks' | 'dependencies' | 'history' | 'isManual'
      > = {
        id: taskId,
        feature_id: featureId,
        status,
        description: cleanDescription,
        effort: validatedEffort,
        completed: false, // All new tasks/subtasks start as not completed.
        ...(parentTaskId && { parentTaskId }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(fromReviewContext && { fromReview: true }), // Set fromReview if in review context
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
          taskDataToValidate
        )}`
      )
      // --- End Enhanced Logging ---

      // Validate against the Task schema before pushing
      const validationResult = TaskSchema.safeParse(taskDataToValidate)
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
    // 1. Ensure all raw steps have effort ratings.
    // ensureEffortRatings preserves existing [high] prefixes from rawPlanSteps
    // and assigns effort to those without a prefix.
    const initialTasksWithEffort = await ensureEffortRatings(
      rawPlanSteps,
      model
    )

    // Explicitly define the tasks to be sent for breakdown processing.
    // This includes tasks from rawPlanSteps that were marked [high]
    // (as ensureEffortRatings preserves such tags) and will be
    // unconditionally processed by processAndBreakdownTasks.
    const tasksForBreakdownProcessing = initialTasksWithEffort

    // 2. Process tasks: Breakdown high-effort ones.
    // processAndBreakdownTasks will identify and attempt to break down tasks
    // with a "[high]" prefix within tasksForBreakdownProcessing.
    const { finalTasks: processedTasks, complexTaskMap: breakdownMap } =
      await processAndBreakdownTasks(
        tasksForBreakdownProcessing, // Using the explicitly defined variable
        model,
        featureId, // Pass featureId for logging/history
        fromReview // Pass the fromReview context flag
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
          await logToFile(
            `[processAndFinalizePlan] Updating task ${existing.id} to set fromReview = true. Context fromReview: ${fromReview}, existing.fromReview: ${existing.fromReview}`
          )
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

    if (!fromReview) {
      // Identify tasks to delete (exist in DB but not in new plan)
      for (const existingTask of existingTasks) {
        if (!processedTaskMap.has(existingTask.id)) {
          taskIdsToDelete.push(existingTask.id)
        }
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
        // Use camelCase 'fromReview' to align with the Task interface expected by addTask
        fromReview: fromReview || task.fromReview || false,
      }
      await logToFile(
        `[processAndFinalizePlan] Adding task ${task.id}. Context fromReview: ${fromReview}, task.fromReview property: ${task.fromReview}, dbTaskPayload.fromReview value: ${dbTaskPayload.fromReview}`,
        'debug'
      )

      try {
        // Ensure that the object passed to addTask conforms to the Task interface
        await databaseService.addTask({
          id: dbTaskPayload.id,
          title: dbTaskPayload.title,
          description: dbTaskPayload.description,
          status: dbTaskPayload.status,
          completed: dbTaskPayload.completed === 1, // Ensure boolean
          effort: dbTaskPayload.effort,
          feature_id: dbTaskPayload.feature_id,
          created_at: dbTaskPayload.created_at,
          updated_at: dbTaskPayload.updated_at,
          fromReview: dbTaskPayload.fromReview, // This is now correctly camelCased
        })
      } catch (dbError) {
        logToFile(
          `[processAndFinalizePlan] Error adding task to database: ${dbError}`
        )
        console.error(`[TaskServer] Error adding task to database:`, dbError)
        throw dbError
      }
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
    // Add detailed logging to debug
    if (finalTasks.length > 0) {
      await logToFile(
        `[processAndFinalizePlan] Sample of final task from DB (finalTasks[0]): ${JSON.stringify(
          finalTasks[0],
          null,
          2
        )}`
      )
    } else {
      await logToFile(
        `[processAndFinalizePlan] No final tasks to log from DB sample.`
      )
    }

    const formattedTasks = finalTasks.map((task: any) => {
      // Create a clean task object for the WebSocket
      return {
        id: task.id,
        description: task.description,
        status: task.status,
        effort: task.effort,
        parentTaskId: task.parentTaskId,
        completed: task.completed,
        title: task.title,
        fromReview: task.fromReview || task.from_review === 1, // Handle both camelCase and snake_case
        createdAt:
          typeof task.createdAt === 'number'
            ? new Date(task.createdAt * 1000).toISOString()
            : undefined,
        updatedAt:
          typeof task.updatedAt === 'number'
            ? new Date(task.updatedAt * 1000).toISOString()
            : undefined,
      }
    })

    // Log the first formatted task
    if (formattedTasks.length > 0) {
      await logToFile(
        `[processAndFinalizePlan] First formatted task for WebSocket (formattedTasks[0]): ${JSON.stringify(
          formattedTasks[0],
          null,
          2
        )}`,
        'debug'
      )
    } else {
      await logToFile(
        `[processAndFinalizePlan] No formatted tasks to log for WebSocket sample.`,
        'debug'
      )
    }

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
