// src/tools/reviewChanges.ts

import { logToFile } from '../lib/logger' // Use specific log functions
import { aiService } from '../services/aiService'
import { promisify } from 'util'
import { exec } from 'child_process'
import crypto from 'crypto'
// Import the correct schema for task list output
import { PlanFeatureResponseSchema, Task } from '../models/types'
import { z } from 'zod'
import {
  parseAndValidateJsonResponse,
  processAndFinalizePlan, // We WILL use this now
} from '../lib/llmUtils'
import {
  GIT_DIFF_MAX_BUFFER_MB,
  GEMINI_MODEL, // Make sure these are imported if needed directly
  OPENROUTER_MODEL, // Make sure these are imported if needed directly
} from '../config'
import path from 'path'
import { getCodebaseContext } from '../lib/repomixUtils'
import { addHistoryEntry, getHistoryForFeature } from '../lib/dbUtils'

const execPromise = promisify(exec)

interface ReviewChangesParams {
  featureId: string // Make featureId mandatory
  project_path?: string
}

// Use the standard response type
interface PlanFeatureStandardResponse {
  status: 'completed' | 'awaiting_clarification' | 'error'
  message: string
  featureId: string
  taskCount?: number
  firstTask?: Task | { description: string; effort: string } // Allow slightly different structure if needed
  uiUrl?: string
  data?: any // For clarification details or other metadata
}

interface ReviewChangesResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export async function handleReviewChanges(
  params: ReviewChangesParams
): Promise<ReviewChangesResult> {
  const { featureId, project_path } = params
  const reviewId = crypto.randomUUID() // Unique ID for this review operation

  logToFile(
    `[TaskServer] Handling review_changes request for feature ${featureId} (Review ID: ${reviewId})`
  )
  // Wrap initial history logging
  try {
    await addHistoryEntry(featureId, 'tool_call', {
      tool: 'review_changes',
      params,
      reviewId,
    })
  } catch (historyError) {
    console.error(
      `[TaskServer] Failed to add initial history entry for review: ${historyError}`
    )
    // Continue execution even if initial history fails
  }

  let targetDir = process.cwd()
  if (project_path) {
    // Basic check for path traversal characters
    if (project_path.includes('..') || project_path.includes('~')) {
      const errorMsg = `Error: Invalid project_path provided: ${project_path}. Path cannot contain '..' or '~'.`
      await logToFile(`[TaskServer] ${errorMsg}`)
      // Try to log error to history before returning
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError: true,
          message: errorMsg,
          reviewId,
          step: 'invalid_path',
        })
      } catch (historyError) {
        /* Ignore */
      }
      return { content: [{ type: 'text', text: errorMsg }], isError: true }
    }

    // Resolve the path and check it's within a reasonable base (e.g., current working directory)
    const resolvedPath = path.resolve(project_path)
    const cwd = process.cwd()

    // This is a basic check; more robust checks might compare against a known workspace root
    if (!resolvedPath.startsWith(cwd)) {
      const errorMsg = `Error: Invalid project_path provided: ${project_path}. Path must be within the current workspace.`
      await logToFile(`[TaskServer] ${errorMsg}`)
      // Try to log error to history before returning
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError: true,
          message: errorMsg,
          reviewId,
          step: 'invalid_path',
        })
      } catch (historyError) {
        /* Ignore */
      }
      return { content: [{ type: 'text', text: errorMsg }], isError: true }
    }
    targetDir = resolvedPath
  }

  try {
    let message: string | null = null
    let isError = false

    const reviewModel = aiService.getReviewModel()
    if (!reviewModel) {
      message = 'Error: Review model not initialized. Check API Key.'
      isError = true
      logToFile(`[TaskServer] ${message} (Review ID: ${reviewId})`)
      // Wrap history logging
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError,
          message,
          reviewId,
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add history entry for model init failure: ${historyError}`
        )
      }
      return { content: [{ type: 'text', text: message }], isError }
    }

    // --- Get Codebase Context --- (Keep as is)
    const { context: codebaseContext, error: contextError } =
      await getCodebaseContext(targetDir, reviewId)
    if (contextError) {
      message = contextError
      isError = true
      // Wrap history logging
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError,
          message,
          reviewId,
          step: 'context_error',
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add history entry for context error: ${historyError}`
        )
      }
      return { content: [{ type: 'text', text: message }], isError }
    }
    // --- End Codebase Context ---

    // --- Git Diff Execution --- (Keep as is)
    let gitDiff = ''
    try {
      await logToFile(
        `[TaskServer] Running git diff HEAD in directory: ${targetDir}... (reviewId: ${reviewId})`
      )
      // Execute git commands directly in the validated target directory
      const diffCmd = `git --no-pager diff HEAD`
      const lsFilesCmd = `git ls-files --others --exclude-standard`
      const execOptions = {
        cwd: targetDir, // Set current working directory for the command
        maxBuffer: GIT_DIFF_MAX_BUFFER_MB * 1024 * 1024,
      }

      const { stdout: diffStdout, stderr: diffStderr } = await execPromise(
        diffCmd,
        execOptions
      )
      if (diffStderr) {
        await logToFile(
          `[TaskServer] git diff stderr: ${diffStderr} (reviewId: ${reviewId})`
        )
      }
      let combinedDiff = diffStdout

      const { stdout: untrackedStdout } = await execPromise(
        lsFilesCmd,
        execOptions
      )
      const untrackedFiles = untrackedStdout
        .split('\n')
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0)
      for (const file of untrackedFiles) {
        // Ensure the filename itself is not malicious (basic check)
        if (file.includes('..') || file.includes('/') || file.includes('\\')) {
          await logToFile(
            `[TaskServer] Skipping potentially unsafe untracked filename: ${file} (reviewId: ${reviewId})`
          )
          continue
        }
        // For each untracked file, get its diff
        const fileDiffCmd = `git --no-pager diff --no-index /dev/null "${file}"`
        try {
          const { stdout: fileDiff } = await execPromise(
            fileDiffCmd,
            execOptions
          )
          if (fileDiff && fileDiff.trim().length > 0) {
            combinedDiff += `\n\n${fileDiff}`
          }
        } catch (fileDiffErr) {
          await logToFile(
            `[TaskServer] Error getting diff for untracked file ${file}: ${fileDiffErr} (reviewId: ${reviewId})`
          )
        }
      }
      gitDiff = combinedDiff
      if (!gitDiff.trim()) {
        message = 'No staged or untracked changes found to review.'
        logToFile(`[TaskServer] ${message} (Review ID: ${reviewId})`)
        // Wrap history logging
        try {
          await addHistoryEntry(featureId, 'tool_response', {
            tool: 'review_changes',
            isError: false,
            message,
            reviewId,
            status: 'no_changes',
          })
        } catch (historyError) {
          console.error(
            `[TaskServer] Failed to add history entry for no_changes status: ${historyError}`
          )
        }
        return { content: [{ type: 'text', text: message }] }
      }
      logToFile(
        `[TaskServer] git diff captured (${gitDiff.length} chars). (Review ID: ${reviewId})`
      )
    } catch (error: any) {
      message = `Error running git diff: ${error.message || error}` // Assign error message
      isError = true
      logToFile(`[TaskServer] ${message} (Review ID: ${reviewId})`, error)
      // Wrap history logging
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError: true,
          message,
          reviewId,
          step: 'git_diff_error',
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add history entry for git diff error: ${historyError}`
        )
      }
      return { content: [{ type: 'text', text: message }], isError }
    }
    // --- End Git Diff ---

    // --- LLM Call to Generate Tasks from Review ---
    try {
      logToFile(
        `[TaskServer] Calling LLM for review analysis and task generation... (Review ID: ${reviewId})`
      )

      // Fetch history to get original feature request
      let originalFeatureRequest = 'Original feature request not found.'
      try {
        const history = await getHistoryForFeature(featureId, 200) // Fetch more history if needed
        const planFeatureCall = history.find(
          (entry) =>
            entry.role === 'tool_call' &&
            entry.content?.tool === 'plan_feature' &&
            entry.content?.params?.feature_description
        )
        if (planFeatureCall) {
          originalFeatureRequest =
            planFeatureCall.content.params.feature_description
          logToFile(
            `[TaskServer] Found original feature request for review context: "${originalFeatureRequest.substring(
              0,
              50
            )}..."`
          )
        } else {
          logToFile(
            `[TaskServer] Could not find original plan_feature call in history for feature ${featureId}.`
          )
        }
      } catch (historyError) {
        logToFile(
          `[TaskServer] Error fetching history to get original feature request: ${historyError}. Proceeding without it.`
        )
      }

      const contextPromptPart = codebaseContext
        ? `\n\nCodebase Context Overview:\n\`\`\`\n${codebaseContext}\n\`\`\`\n`
        : '\n\n(No overall codebase context was available.)'

      // *** REVISED Prompt: Ask for TASKS based on checklist criteria ***
      const structuredPrompt = `You are a senior software engineer performing a code review.
Original Feature Request Context: "${originalFeatureRequest}"

Review the following code changes (git diff) and consider the overall codebase context (if provided).
Your goal is to identify necessary fixes, improvements, or refactorings based on standard best practices and generate a list of actionable coding tasks for another developer to implement.

\`\`\`diff
${gitDiff}
\`\`\`
${contextPromptPart}
**Review Criteria (Generate tasks based on these):**
1.  **Functionality:** Does the change work? Are there bugs? Handle edge cases & errors?
2.  **Design:** Does it fit the architecture? Is it modular/maintainable (SOLID/DRY)? Overly complex?
3.  **Readability:** Is code clear? Are names good? Are comments needed (explaining 'why')? Style consistent?
4.  **Maintainability:** Easy to modify/debug/test? Clean dependencies?
5.  **Performance:** Obvious bottlenecks?
6.  **Security:** Potential vulnerabilities (input validation, etc.)?
7.  **Testing:** Are tests needed/adequate (if context allows)?

**Output Format:**
Respond ONLY with a single valid JSON object matching this exact schema:
{
  "tasks": [
    {
      "description": "string // Clear, concise description of the required coding action.",
      "effort": "'low' | 'medium' | 'high' // Estimated effort level."
    }
    // ... include all actionable tasks generated from the review.
    // If NO tasks are needed, return an empty array: "tasks": []
  ]
}

Do NOT include summaries, commentary, or anything outside this JSON structure. Do not use markdown formatting.`

      let llmResponseData: { tasks: Task[] } | null = null
      let rawLLMResponse: any = null

      // Call LLM using aiService - Attempt structured output
      if ('chat' in reviewModel) {
        // OpenRouter
        const structuredResult = await aiService.callOpenRouterWithSchema(
          process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5:free', // Use configured or default for review
          [{ role: 'user', content: structuredPrompt }],
          PlanFeatureResponseSchema, // Use the task list schema
          { temperature: 0.5 } // Slightly higher temp might be ok for task generation
        )
        rawLLMResponse = structuredResult.rawResponse

        if (structuredResult.success) {
          llmResponseData = structuredResult.data as { tasks: Task[] }
          // Wrap history logging
          try {
            await addHistoryEntry(featureId, 'model', {
              tool: 'review_changes',
              reviewId,
              response: llmResponseData,
              structured: true,
            })
          } catch (historyError) {
            console.error(
              `[TaskServer] Failed to add history entry for successful structured OpenRouter response: ${historyError}`
            )
          }
        } else {
          logToFile(
            `[TaskServer] Structured review task generation failed (OpenRouter): ${structuredResult.error}. Cannot reliably generate tasks from review.`
          )
          message = `Error: AI failed to generate structured tasks based on review: ${structuredResult.error}`
          isError = true
          // Wrap history logging
          try {
            await addHistoryEntry(featureId, 'tool_response', {
              tool: 'review_changes',
              isError,
              message,
              reviewId,
              step: 'llm_structured_fail',
            })
          } catch (historyError) {
            console.error(
              `[TaskServer] Failed to add history entry for OpenRouter structured fail: ${historyError}`
            )
          }
          return { content: [{ type: 'text', text: message }], isError }
        }
      } else {
        // Gemini
        const structuredResult = await aiService.callGeminiWithSchema(
          process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest',
          structuredPrompt,
          PlanFeatureResponseSchema, // Use the task list schema
          { temperature: 0.5 }
        )
        rawLLMResponse = structuredResult.rawResponse

        if (structuredResult.success) {
          llmResponseData = structuredResult.data as { tasks: Task[] }
          // Wrap history logging
          try {
            await addHistoryEntry(featureId, 'model', {
              tool: 'review_changes',
              reviewId,
              response: llmResponseData,
              structured: true,
            })
          } catch (historyError) {
            console.error(
              `[TaskServer] Failed to add history entry for successful structured Gemini response: ${historyError}`
            )
          }
        } else {
          logToFile(
            `[TaskServer] Structured review task generation failed (Gemini): ${structuredResult.error}. Cannot reliably generate tasks from review.`
          )
          message = `Error: AI failed to generate structured tasks based on review: ${structuredResult.error}`
          isError = true
          // Wrap history logging
          try {
            await addHistoryEntry(featureId, 'tool_response', {
              tool: 'review_changes',
              isError,
              message,
              reviewId,
              step: 'llm_structured_fail',
            })
          } catch (historyError) {
            console.error(
              `[TaskServer] Failed to add history entry for Gemini structured fail: ${historyError}`
            )
          }
          return { content: [{ type: 'text', text: message }], isError }
        }
      }

      // --- Process and Save Generated Tasks ---
      if (!llmResponseData || !llmResponseData.tasks) {
        message = 'Error: LLM response did not contain a valid task list.'
        isError = true
        logToFile(`[TaskServer] ${message} (Review ID: ${reviewId})`)
        // Wrap history logging
        try {
          await addHistoryEntry(featureId, 'tool_response', {
            tool: 'review_changes',
            isError,
            message,
            reviewId,
            step: 'task_processing_error',
          })
        } catch (historyError) {
          console.error(
            `[TaskServer] Failed to add history entry for task processing error: ${historyError}`
          )
        }
        return { content: [{ type: 'text', text: message }], isError }
      }

      if (llmResponseData.tasks.length === 0) {
        message =
          'Code review completed. No immediate action tasks were identified.'
        logToFile(`[TaskServer] ${message} (Review ID: ${reviewId})`)
        // Wrap history logging
        try {
          await addHistoryEntry(featureId, 'tool_response', {
            tool: 'review_changes',
            isError: false,
            message,
            reviewId,
            status: 'no_tasks_generated',
          })
        } catch (historyError) {
          console.error(
            `[TaskServer] Failed to add history entry for no_tasks_generated status: ${historyError}`
          )
        }
        return { content: [{ type: 'text', text: message }], isError: false }
      }

      // Format tasks for processing (like in planFeature)
      const rawPlanSteps = llmResponseData.tasks.map(
        (task) => `[${task.effort}] ${task.description}`
      )

      logToFile(
        `[TaskServer] Generated ${rawPlanSteps.length} tasks from review. Processing... (Review ID: ${reviewId})`
      )

      // Process these tasks (effort check, breakdown, save, notify)
      // This adds the review-generated tasks to the existing feature plan
      const finalTasks = await processAndFinalizePlan(
        rawPlanSteps,
        reviewModel, // Use the same model for potential breakdown
        featureId,
        true // Indicate tasks came from review context
      )

      const taskCount = finalTasks.length // Count tasks *added* or processed
      const firstNewTask = finalTasks[0] // Get the first task generated by *this* review

      const responseData: PlanFeatureStandardResponse = {
        status: 'completed', // Indicates review+task generation is done
        // Provide a clear message indicating tasks were *added* from review
        message: `Code review complete. Generated ${taskCount} actionable tasks based on the review. ${
          firstNewTask
            ? 'First new task: "' + firstNewTask.description + '"'
            : ''
        } Call 'get_next_task' with featureId '${featureId}' to continue implementation.`,
        featureId: featureId,
        taskCount: taskCount,
        firstTask: firstNewTask
          ? {
              description: firstNewTask.description || '',
              effort: firstNewTask.effort || 'medium',
            }
          : undefined, // Ensure effort is present
      }

      logToFile(
        `[TaskServer] Review tasks processed and saved for feature ${featureId}. (Review ID: ${reviewId})`
      )
      // Wrap history logging
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError: false,
          message: responseData.message,
          reviewId,
          responseData,
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add final success history entry: ${historyError}`
        )
      }

      // Return the standardized response object, serialized
      return {
        content: [{ type: 'text', text: JSON.stringify(responseData) }],
        isError: false,
      }
    } catch (error: any) {
      message = `Error occurred during review analysis API call: ${error.message}`
      isError = true
      logToFile(
        `[TaskServer] Error calling LLM review API (Review ID: ${reviewId})`,
        error
      )
      // Wrap history logging inside the catch block
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'review_changes',
          isError,
          message,
          error: error.message,
          reviewId,
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add error history entry during LLM API call failure: ${historyError}`
        )
      }
      return { content: [{ type: 'text', text: message }], isError }
    }
  } catch (error: any) {
    // Outer catch already wraps history logging and ignores errors
    const errorMsg = `Error processing review_changes request: ${error.message}`
    logToFile(`[TaskServer] ${errorMsg} (Review ID: ${reviewId})`, error)
    try {
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'review_changes',
        isError: true,
        message: errorMsg,
        reviewId,
        step: 'preprocessing_error',
      })
    } catch (historyError) {
      /* Ignore */
    }
    return { content: [{ type: 'text', text: errorMsg }], isError: true }
  }
}
