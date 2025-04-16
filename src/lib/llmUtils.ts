import { GenerateContentResult, GenerativeModel } from '@google/generative-ai'
import OpenAI from 'openai'
import { BreakdownOptions } from '../models/types'
import { aiService } from '../services/aiService'
import { logToFile } from './logger'
import { safetySettings } from '../config'

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

Provide ONLY ONE of these words as your answer: "low", "medium", or "high".
`

  try {
    let result
    if (model instanceof OpenAI) {
      // Use OpenRouter
      result = await model.chat.completions.create({
        model: 'google/gemini-2.5-pro-exp-03-25:free',
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

    const resultText = aiService.extractTextFromResponse(result)

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
    return 'medium'
  } catch (error) {
    console.error('[TaskServer] Error determining task effort:', error)
    return 'medium' // Default to medium on error
  }
}

/**
 * Breaks down a high-effort task into subtasks using an LLM.
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
Break down this high-effort **coding task** into a list of smaller, sequential, actionable coding subtasks:\n"${taskDescription}"\n\nGuidelines:\n1. Create ${minSubtasks}-${maxSubtasks} subtasks.\n2. Each subtask should ideally be 'low' or 'medium' effort, focusing on a specific part of the implementation.\n3. Make each subtask a concrete coding action (e.g., "Create function X", "Refactor module Y", "Add field Z to interface").\n4. The subtasks should represent a logical sequence for implementation.\n5. **Only include the list of coding subtasks** (numbered 1, 2, 3, etc.). Do NOT include explanations, introductions, non-coding steps like testing, deployment, or documentation.\n`

  try {
    let breakdownResult
    if (model instanceof OpenAI) {
      // Use OpenRouter
      breakdownResult = await model.chat.completions.create({
        model: 'google/gemini-2.5-pro-exp-03-25:free',
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

    const breakdownText = aiService.extractTextFromResponse(breakdownResult)

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
