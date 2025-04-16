import path from 'path'
import crypto from 'crypto'
import {
  Task,
  PlanFeatureResponseSchema,
  PlanningOutputSchema,
  PlanningTaskSchema,
} from '../models/types'
import { promisify } from 'util'
import { aiService } from '../services/aiService'
import {
  parseGeminiPlanResponse,
  determineTaskEffort,
  breakDownHighEffortTask,
  extractParentTaskId,
  extractEffort,
} from '../lib/llmUtils'
import { logToFile } from '../lib/logger'
import { readTasks, writeTasks, addHistoryEntry } from '../lib/fsUtils'
import fs from 'fs/promises'
import { exec } from 'child_process'
import * as fsSync from 'fs'
import { encoding_for_model } from 'tiktoken'
import webSocketService from '../services/webSocketService'
import { z } from 'zod'
import { GEMINI_MODEL, OPENROUTER_MODEL, WS_PORT, UI_PORT } from '../config'
import { dynamicImportDefault } from '../lib/utils'

// Promisify child_process.exec for easier async/await usage
const execPromise = promisify(exec)

interface PlanFeatureParams {
  feature_description: string
  project_path: string
}

interface PlanFeatureResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Handles the plan_feature tool request
 */
export async function handlePlanFeature(
  params: PlanFeatureParams
): Promise<PlanFeatureResult> {
  const { feature_description, project_path } = params

  // Generate a unique feature ID *first*
  const featureId = crypto.randomUUID()

  await logToFile(
    `[TaskServer] Handling plan_feature request: "${feature_description}" (Path: ${
      project_path || 'CWD'
    }), Feature ID: ${featureId}`
  )

  // Define message and isError outside the try block to ensure they are always available
  let message: string
  let isError = false
  let task_count: number | undefined = undefined // Keep track of task count

  try {
    // Record tool call in history *early*
    await addHistoryEntry(featureId, 'tool_call', {
      tool: 'plan_feature',
      params: { feature_description, project_path },
    })

    const planningModel = aiService.getPlanningModel()

    if (!planningModel) {
      await logToFile(
        '[TaskServer] Planning model not initialized (check API key).'
      )
      message = 'Error: Planning model not initialized. Check API Key.'
      isError = true

      // Record error in history
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        isError: true,
        message,
      })

      // Return the structured error object
      return { content: [{ type: 'text', text: message }], isError }
    }

    // --- Repomix Execution ---
    let codebaseContext = ''
    try {
      const targetDir = project_path || '.'
      const repomixOutputPath = path.join(targetDir, 'repomix-output.txt')
      // Ensure the output directory exists (needed if targetDir is nested and doesn't exist yet)
      await fs.mkdir(path.dirname(repomixOutputPath), { recursive: true })

      let command = `npx repomix ${targetDir} --style plain --output ${repomixOutputPath}`

      console.error(`[TaskServer] Running repomix command: ${command}`)
      await logToFile(`[TaskServer] Running repomix command: ${command}`)

      let { stdout, stderr } = await execPromise(command, {
        maxBuffer: 10 * 1024 * 1024,
      })

      if (stderr) {
        await logToFile(`[TaskServer] repomix stderr: ${stderr}`)
        if (stderr.includes('Permission denied')) {
          message = `Error running repomix: Permission denied scanning directory '${targetDir}'. Check folder permissions.`
          isError = true
          await addHistoryEntry(featureId, 'tool_response', {
            tool: 'plan_feature',
            isError: true,
            message,
            step: 'repomix_execution',
          })
          return { content: [{ type: 'text', text: message }], isError }
        }
      }
      if (!stdout && !(await fs.stat(repomixOutputPath).catch(() => null))) {
        await logToFile(
          '[TaskServer] repomix stdout was empty and output file does not exist.'
        )
        // Handle case where repomix might not produce output but doesn't error
      }

      // Read repomix-output.txt (handle potential non-existence)
      try {
        codebaseContext = await fs.readFile(repomixOutputPath, 'utf-8')
      } catch (readError: any) {
        if (readError.code === 'ENOENT') {
          await logToFile(
            `[TaskServer] repomix-output.txt not found at ${repomixOutputPath}. Proceeding without context.`
          )
          codebaseContext = '' // Proceed without context if file missing
        } else {
          throw readError // Re-throw other read errors
        }
      }

      if (!codebaseContext.trim()) {
        await logToFile(
          `[TaskServer] repomix output file (${repomixOutputPath}) was empty or missing.`
        )
        codebaseContext = '' // Ensure it's an empty string if no content
      }

      // Check token count (only if context exists)
      if (codebaseContext) {
        let tokenCount = 0
        try {
          const enc = encoding_for_model('gpt-4') // Or appropriate model
          tokenCount = enc.encode(codebaseContext).length
          enc.free()
        } catch (tokenError) {
          await logToFile(
            `[TaskServer] Token counting failed, using approximation: ${tokenError}`
          )
          tokenCount = Math.ceil(codebaseContext.length / 4)
        }

        const TOKEN_LIMIT = 1000000 // Example limit

        if (tokenCount > TOKEN_LIMIT) {
          await logToFile(
            `[TaskServer] Repomix output too large (${tokenCount.toLocaleString()} tokens). Re-running with --compress flag.`
          )
          command = `npx repomix ${targetDir} --style plain --compress --output ${repomixOutputPath}`
          console.error(
            `[TaskServer] Re-running repomix with compression: ${command}`
          )
          await logToFile(
            `[TaskServer] Re-running repomix command with compression: ${command}`
          )

          const compressResult = await execPromise(command, {
            maxBuffer: 10 * 1024 * 1024,
          })
          if (compressResult.stderr) {
            await logToFile(
              `[TaskServer] repomix (compressed) stderr: ${compressResult.stderr}`
            )
          }

          try {
            codebaseContext = await fs.readFile(repomixOutputPath, 'utf-8')
          } catch (readError: any) {
            if (readError.code === 'ENOENT') {
              await logToFile(
                `[TaskServer] Compressed repomix-output.txt not found at ${repomixOutputPath}. Proceeding without context.`
              )
              codebaseContext = ''
            } else {
              throw readError
            }
          }

          if (!codebaseContext.trim()) {
            await logToFile(
              `[TaskServer] Compressed repomix output file (${repomixOutputPath}) was empty or missing.`
            )
            codebaseContext = ''
          } else {
            let compressedTokenCount = 0
            try {
              const enc = encoding_for_model('gpt-4')
              compressedTokenCount = enc.encode(codebaseContext).length
              enc.free()
              await logToFile(
                `[TaskServer] Compressed output token count: ${compressedTokenCount.toLocaleString()}`
              )
            } catch (tokenError) {
              await logToFile(
                `[TaskServer] Compressed token counting failed: ${tokenError}`
              )
            }
            await logToFile(
              `[TaskServer] Compressed repomix context gathered (${
                codebaseContext.length
              } chars, ~${compressedTokenCount.toLocaleString()} tokens) for path: ${targetDir}.`
            )
          }
        } else {
          await logToFile(
            `[TaskServer] repomix context gathered (${
              codebaseContext.length
            } chars, ${tokenCount.toLocaleString()} tokens) for path: ${targetDir}.`
          )
        }
      } else {
        await logToFile(
          `[TaskServer] No codebase context gathered (repomix output was empty or missing).`
        )
      }
    } catch (error: any) {
      await logToFile(`[TaskServer] Error running repomix: ${error}`)
      let errorMessage = 'Error running repomix to gather codebase context.'
      if (error.message?.includes('command not found')) {
        errorMessage =
          "Error: 'npx' or 'repomix' command not found. Make sure Node.js and repomix are installed and in the PATH."
      } else if (error.stderr?.includes('Permission denied')) {
        errorMessage = `Error running repomix: Permission denied scanning directory. Check folder permissions.`
      }
      message = errorMessage
      isError = true
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        isError: true,
        message,
        step: 'repomix_execution',
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error),
      })
      return { content: [{ type: 'text', text: message }], isError }
    }

    // --- LLM Planning & Task Generation ---
    let planSteps: string[] = []
    let complexTaskMap = new Map<string, string>() // Map original high-effort task description to its generated parent ID

    try {
      await logToFile('[TaskServer] Calling LLM API for planning...')
      const contextPromptPart = codebaseContext
        ? `Based on the following codebase context:\n\`\`\`\n${codebaseContext}\n\`\`\`\n\n`
        : 'Based on the provided feature description (no codebase context available):\n\n'

      const prompt = `${contextPromptPart}Generate a detailed, step-by-step **coding implementation plan** for the feature: \"${feature_description}\".
      
        The plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.
        
        For each **coding task**, you MUST include an **effort rating** (low, medium, or high) in square brackets at the beginning of each task description, based on implementation work involved. High effort tasks often require breakdown.
        
        Use these effort definitions:
        - Low: Simple, quick changes in one or few files, minimal logic changes.
        - Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes. Might need 1-3 sub-steps.
        - High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring. Likely needs multiple sub-steps (3+).
        
        Provide each coding task as a separate item on a new line. Do not use markdown list markers (like -, *, +). Ensure the plan is sequential where applicable.
        
        **IMPORTANT OUTPUT FORMATTING:** Every single task description you generate MUST begin with the effort rating in square brackets.
        
        **Examples of the required format:**
        [low] Update the copyright year in the footer component.
        [medium] Create the database migration script for the new 'orders' table.
        [high] Refactor the user authentication module to support multi-factor authentication.
        
        **IMPORTANT: Do NOT include any introductory sentences, summaries, concluding remarks, or any text other than the formatted task list itself. The response must start *directly* with the first task (e.g., "[low] Add console log...").**
        
        Now, generate the list of coding tasks, ensuring each task strictly follows this format: [effort] Task Description`

      // Log truncated prompt for history
      await addHistoryEntry(featureId, 'model', {
        step: 'planning_prompt',
        prompt: `Generate plan for: "${feature_description}" ${
          codebaseContext ? '(with context)' : '(no context)'
        }...`,
      })

      // Use the appropriate model for planning (through aiService)
      let result
      if (planningModel) {
        if ('chat' in planningModel) {
          // It's OpenRouter - Use structured output
          const structuredPrompt = `${contextPromptPart}Generate a detailed, step-by-step coding implementation plan for the feature: "${feature_description}".
          
          The plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.
          
          For each coding task, include an effort rating (low, medium, or high) based on implementation work involved. High effort tasks often require breakdown.
          
          Use these effort definitions:
          - Low: Simple, quick changes in one or few files, minimal logic changes.
          - Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes.
          - High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring.
          
          Respond with a valid JSON object containing an array of tasks, each with a description and effort level.`

          const structuredResult = await aiService.callOpenRouterWithSchema(
            OPENROUTER_MODEL,
            [{ role: 'user', content: structuredPrompt }],
            PlanFeatureResponseSchema,
            { temperature: 0.7 }
          )

          logToFile(
            `[TaskServer] Structured result: ${JSON.stringify(
              structuredResult
            )}`
          )

          if (structuredResult.success) {
            // Convert the structured response to the expected format
            planSteps = structuredResult.data.tasks.map(
              (task) => `[${task.effort}] ${task.description}`
            )

            await addHistoryEntry(featureId, 'model', {
              step: 'structured_planning_response',
              response: JSON.stringify(structuredResult.data),
            })

            // Store the raw response for reference
            result = structuredResult.rawResponse
          } else {
            // Fallback to unstructured response if structured fails
            console.warn(
              `[TaskServer] Structured planning failed: ${structuredResult.error}. Falling back to unstructured format.`
            )

            // Use traditional prompt and formatting
            result = await planningModel.chat.completions.create({
              model: OPENROUTER_MODEL,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.7,
            })
          }
        } else {
          // It's Gemini - Use structured output
          const structuredPrompt = `${contextPromptPart}Generate a detailed, step-by-step coding implementation plan for the feature: "${feature_description}".
          
          The plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.
          
          For each coding task, include an effort rating (low, medium, or high) based on implementation work involved. High effort tasks often require breakdown.
          
          Use these effort definitions:
          - Low: Simple, quick changes in one or few files, minimal logic changes.
          - Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes.
          - High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring.
          
          Respond with a valid JSON object containing an array of tasks, each with a description and effort level.`

          const structuredResult = await aiService.callGeminiWithSchema(
            GEMINI_MODEL,
            structuredPrompt,
            PlanFeatureResponseSchema,
            { temperature: 0.7 }
          )

          if (structuredResult.success) {
            // Convert the structured response to the expected format
            planSteps = structuredResult.data.tasks.map(
              (task) => `[${task.effort}] ${task.description}`
            )

            await addHistoryEntry(featureId, 'model', {
              step: 'structured_planning_response',
              response: JSON.stringify(structuredResult.data),
            })

            // Store the raw response for reference
            result = structuredResult.rawResponse
          } else {
            // Fallback to unstructured response if structured fails
            console.warn(
              `[TaskServer] Structured planning failed: ${structuredResult.error}. Falling back to unstructured format.`
            )

            // Use traditional Gemini call
            result = await planningModel.generateContent({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.7,
              },
            })
          }
        }
      }

      const responseText = aiService.extractTextFromResponse(result)

      if (responseText === null) {
        message =
          'Error: Failed to get planning response from LLM or response was blocked. AI Agent: Do not try to call again. Simply alert the user.'
        isError = true
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'plan_feature',
          isError: true,
          message,
          step: 'llm_planning',
        })
        return { content: [{ type: 'text', text: message }], isError }
      }

      // Only add entry if we haven't already done so in the fallback path
      if (!planSteps.length) {
        await addHistoryEntry(featureId, 'model', {
          step: 'planning_response',
          response: responseText,
        })

        // Only parse if planSteps is empty (meaning we didn't get structured results or fallback parsing)
        planSteps = parseGeminiPlanResponse(responseText)
        await logToFile(
          `[TaskServer] Received plan with ${planSteps.length} raw steps from LLM.`
        )
      }

      // Ensure we have at least some plan steps to proceed
      if (planSteps.length === 0) {
        message =
          'Error: Failed to parse any valid tasks from the LLM response.'
        isError = true
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'plan_feature',
          isError: true,
          message,
          step: 'task_parsing',
        })
        return { content: [{ type: 'text', text: message }], isError }
      }

      // --- Process LLM Response (Effort, Breakdown, Sequencing) ---

      // 1. Add/Verify Effort Ratings
      const effortRatedSteps: string[] = []
      for (const taskDesc of planSteps) {
        if (taskDesc.match(/^\[(low|medium|high)\]/i)) {
          effortRatedSteps.push(taskDesc)
        } else {
          try {
            const effort = await determineTaskEffort(taskDesc, planningModel)
            effortRatedSteps.push(`[${effort}] ${taskDesc}`)
          } catch (error) {
            effortRatedSteps.push(`[medium] ${taskDesc}`) // Default on error
            console.error(
              `[TaskServer] Error determining effort for task "${taskDesc.substring(
                0,
                40
              )}...":`,
              error
            )
          }
        }
      }
      await logToFile(
        `[TaskServer] Processed effort ratings for ${effortRatedSteps.length} steps.`
      )

      // 2. Identify High Effort Tasks for Breakdown
      const tasksToKeepOrBreakdown: string[] = [...effortRatedSteps]
      const finalProcessedSteps: string[] = [] // Will hold final list including subtasks in order
      let breakdownSuccesses = 0
      let breakdownFailures = 0

      for (const step of tasksToKeepOrBreakdown) {
        const effortMatch = step.match(/^\[(low|medium|high)\]/i)
        const isHighEffort =
          effortMatch && effortMatch[1].toLowerCase() === 'high'

        if (isHighEffort) {
          const taskDescription = step.replace(/^\[high\]\s*/i, '')
          const parentId = crypto.randomUUID()
          complexTaskMap.set(taskDescription, parentId) // Map description to ID

          await addHistoryEntry(featureId, 'model', {
            step: 'task_breakdown_attempt',
            task: step,
            parentId,
          })

          const subtasks = await breakDownHighEffortTask(
            taskDescription,
            parentId,
            planningModel,
            { minSubtasks: 2, maxSubtasks: 5, preferredEffort: 'medium' }
          )

          if (subtasks.length > 0) {
            // Add parent container task (marked completed later)
            finalProcessedSteps.push(`${step} [parentContainer]`) // Add marker

            // Process and add subtasks immediately after parent
            const subtasksWithParentIdAndEffort = await Promise.all(
              subtasks.map(async (subtaskDesc) => {
                const {
                  description: cleanSubDescNoEffort,
                  effort: subEffortInitial,
                } = extractEffort(subtaskDesc)
                // Ensure effort is valid or determine/default it
                let finalEffort = subEffortInitial
                if (!['low', 'medium', 'high'].includes(finalEffort)) {
                  try {
                    finalEffort = await determineTaskEffort(
                      cleanSubDescNoEffort,
                      planningModel
                    )
                  } catch {
                    finalEffort = 'medium' // Default on error
                  }
                }
                return `[${finalEffort}] ${cleanSubDescNoEffort} [parentTask:${parentId}]`
              })
            )
            finalProcessedSteps.push(...subtasksWithParentIdAndEffort)

            await addHistoryEntry(featureId, 'model', {
              step: 'task_breakdown_success',
              task: step,
              parentId,
              subtasks: subtasksWithParentIdAndEffort,
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
        } else {
          // Keep low/medium effort tasks as is
          finalProcessedSteps.push(step)
        }
      }

      planSteps = finalProcessedSteps // Update planSteps with the final ordered list
      await logToFile(
        `[TaskServer] Final plan processing: ${planSteps.length} total steps in sequence (${breakdownSuccesses} successful breakdowns, ${breakdownFailures} failures).`
      )

      if (planSteps.length === 0) {
        await logToFile(
          '[TaskServer] Planning resulted in zero tasks after processing.'
        )
        message =
          'Planning resulted in zero actionable tasks. The LLM might need a more specific prompt or the feature is too simple.'
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'plan_feature',
          isError: false,
          message,
          step: 'plan_validation',
          warning: 'zero_tasks',
        })
        return { content: [{ type: 'text', text: message }] }
      }

      // --- Create Task Objects and Save ---
      const newTasks: Task[] = planSteps.map((step) => {
        const isParentContainer = step.includes('[parentContainer]')
        const descriptionWithTags = step.replace('[parentContainer]', '').trim()

        const { description: descWithoutParent, parentTaskId } =
          extractParentTaskId(descriptionWithTags)
        const { description: cleanDescription, effort } =
          extractEffort(descWithoutParent)

        // Get the predetermined ID for parent containers, otherwise generate new
        const taskId =
          complexTaskMap.get(cleanDescription) || crypto.randomUUID()

        return {
          id: taskId,
          status: isParentContainer ? 'completed' : 'pending', // Mark containers as completed
          description: cleanDescription,
          effort: effort,
          ...(parentTaskId && { parentTaskId }),
        }
      })

      task_count = newTasks.filter((task) => task.status === 'pending').length // Count only actionable (pending) tasks

      await writeTasks(featureId, newTasks)
      await logToFile(
        `[TaskServer] New plan saved for feature ${featureId} with ${newTasks.length} total items (${task_count} pending tasks).`
      )

      // Broadcast the tasks update via WebSocket
      try {
        webSocketService.notifyTasksUpdated(featureId, newTasks)
        await logToFile(
          `[TaskServer] Broadcast tasks_updated event for feature ${featureId}`
        )
      } catch (wsError) {
        await logToFile(
          `[TaskServer] Warning: Failed to broadcast task update: ${wsError}`
        )
        // Don't fail the operation if WebSocket broadcast fails
      }

      // Launch the UI in the user's browser with the feature ID
      try {
        const uiUrl = `http://localhost:${UI_PORT}?featureId=${featureId}` // Construct URL with featureId

        await logToFile(`[TaskServer] Launching UI in browser: ${uiUrl}`)

        // Use the dynamic import helper function to get the 'open' function
        const open = await dynamicImportDefault<typeof import('open')>('open')
        await open(uiUrl) // Call the dynamically imported function

        await logToFile('[TaskServer] Browser launch initiated successfully')
      } catch (launchError) {
        // Log the error but don't fail the operation
        await logToFile(
          `[TaskServer] Warning: Failed to launch browser UI: ${launchError}`
        )
        console.error(
          '[TaskServer] Warning: Failed to launch browser UI:',
          launchError
        )
      }

      // Success message includes the feature ID and task count
      message = `Successfully generated plan for feature ID ${featureId} with ${task_count} pending tasks: "${feature_description}"`

      // Find the first pending task to include in the response
      const firstTask = newTasks.find((task) => task.status === 'pending')

      if (firstTask) {
        // Include effort in the message if available
        const effortInfo = firstTask.effort
          ? ` (Effort: ${firstTask.effort})`
          : ''

        // Include parent info if this is a subtask
        let parentInfo = ''
        if (firstTask.parentTaskId) {
          // Find the parent task
          const parentTask = newTasks.find(
            (t) => t.id === firstTask.parentTaskId
          )
          if (parentTask) {
            const parentDesc =
              parentTask.description.length > 30
                ? parentTask.description.substring(0, 30) + '...'
                : parentTask.description
            parentInfo = ` (Subtask of: "${parentDesc}")`
          } else {
            parentInfo = ` (Subtask of parent ID: ${firstTask.parentTaskId})` // Fallback if parent not found
          }
        }

        // Add the first task info to the message
        const firstTaskMessage = `\n\nNext pending task (ID: ${firstTask.id})${effortInfo}${parentInfo}: ${firstTask.description}`
        message = message + firstTaskMessage
      }

      // Record success in history
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        isError: false,
        message,
        featureId: featureId,
        taskCount: task_count,
        firstTask: firstTask || undefined,
      })

      // Return success structure with featureId in the message
      return {
        content: [{ type: 'text', text: message }],
      }
    } catch (error) {
      console.error(
        '[TaskServer] Error during LLM planning or task processing:',
        error
      )
      message =
        'Error occurred during feature planning API call or task processing.'
      isError = true
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        isError: true,
        message,
        step: 'llm_processing',
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error),
      })
      return { content: [{ type: 'text', text: message }], isError }
    }
  } catch (error) {
    // Catch any unexpected errors during the entire process
    const errorMsg = `Unexpected error processing plan_feature request for feature ${featureId}: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(`[TaskServer] ${errorMsg}`)
    await logToFile(`[TaskServer] ${errorMsg}`) // Log unexpected errors too

    // Record error in history (even if featureId was just generated)
    try {
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        isError: true,
        message: errorMsg,
        step: 'handler_top_level_catch',
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error),
      })
    } catch (historyError) {
      console.error(
        `[TaskServer] Failed to record top-level error in history: ${historyError}`
      )
    }

    // Ensure a valid error structure is returned
    return {
      content: [{ type: 'text', text: errorMsg }],
      isError: true,
    }
  }
}
