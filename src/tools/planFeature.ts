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
  extractParentTaskId,
  extractEffort,
  ensureEffortRatings,
  processAndBreakdownTasks,
  detectClarificationRequest,
  processAndFinalizePlan,
} from '../lib/llmUtils'
import { logToFile } from '../lib/logger'
import fs from 'fs/promises'
import { exec } from 'child_process'
import * as fsSync from 'fs'
import { encoding_for_model } from 'tiktoken'
import webSocketService from '../services/webSocketService'
import { z } from 'zod'
import { GEMINI_MODEL, OPENROUTER_MODEL, WS_PORT, UI_PORT } from '../config'
import { dynamicImportDefault } from '../lib/utils'
import planningStateService from '../services/planningStateService'
import { databaseService } from '../services/databaseService'
import { addHistoryEntry } from '../lib/dbUtils'
import { getCodebaseContext } from '../lib/repomixUtils'

// Promisify child_process.exec for easier async/await usage
const execPromise = promisify(exec)

interface PlanFeatureParams {
  feature_description: string
  project_path: string
}

// Revert interface to only expect text content for SDK compatibility
interface PlanFeatureResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

// Define a standard structure for the serialized response
interface PlanFeatureStandardResponse {
  status: 'completed' | 'awaiting_clarification' | 'error'
  message: string
  featureId: string
  data?: any // For clarification details or potentially first task info
  uiUrl?: string // Include UI URL for convenience
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
  // Define UI URL early
  const uiUrl = `http://localhost:${UI_PORT || 4999}?featureId=${featureId}`
  let browserOpened = false // Flag to track if browser was opened for clarification

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

      // Record error in history, handling potential logging errors
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'plan_feature',
          isError: true,
          message,
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add error history entry during model init failure: ${historyError}`
        )
      }

      // Return the structured error object *serialized*
      const errorResponse: PlanFeatureStandardResponse = {
        status: 'error',
        message: message,
        featureId: featureId, // Include featureId even in early errors
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(errorResponse) }],
        isError,
      }
    }

    // --- Get Codebase Context using Utility Function ---
    const targetDir = project_path || '.' // Keep targetDir logic
    const { context: codebaseContext, error: contextError } =
      await getCodebaseContext(
        targetDir,
        featureId // Use featureId as log context
      )

    // Handle potential errors from getCodebaseContext
    if (contextError) {
      message = contextError // Use the user-friendly error from the utility
      isError = true
      // Record error in history, handling potential logging errors
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'plan_feature',
          isError: true,
          message,
          step: 'repomix_context_gathering',
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add error history entry during context gathering failure: ${historyError}`
        )
      }
      return { content: [{ type: 'text', text: message }], isError }
    }

    // Optional: Add token counting / compression logic here if needed,
    // operating on the returned `codebaseContext`.
    // This part is kept separate from the core getCodebaseContext utility for now.
    // ... (Token counting and compression logic could go here)

    // --- LLM Planning & Task Generation ---
    let planSteps: string[] = []

    try {
      await logToFile('[TaskServer] Calling LLM API for planning...')
      const contextPromptPart = codebaseContext
        ? `Based on the following codebase context:\n\`\`\`\n${codebaseContext}\n\`\`\`\n\n`
        : 'Based on the provided feature description (no codebase context available):\n\n'

      // Define the structured planning prompt incorporating the new schema
      const structuredPlanningPrompt = `${contextPromptPart}Generate a detailed, step-by-step coding implementation plan for the feature: \"${feature_description}\".
      
        The plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.
        
        For each coding task, include an effort rating (low, medium, or high) based on implementation work involved. High effort tasks often require breakdown.
        
        Use these effort definitions:
        - Low: Simple, quick changes in one or few files, minimal logic changes.
        - Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes.
        - High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring.
        
        **RESPONSE FORMAT:**
        You MUST respond with a single JSON object.
        
        **Case 1: Clarification Needed**
        If you require clarification before creating the plan, respond with this JSON structure:
        \`\`\`json
        {\n          "clarificationNeeded": {\n            "question": "Your specific question here. Be precise.",
        \n            "options": ["Option A", "Option B"] // Optional: Provide options if helpful
        \n            "allowsText": true // Optional: Set to false if only options are valid
        \n          }\n        }\`\`\`
        
        **Case 2: No Clarification Needed**
        If you DO NOT need clarification, respond with this JSON structure, containing a non-empty array of tasks:
        \`\`\`json
        {\n          "tasks": [\n            { "description": "Description of the first task", "effort": "low" | "medium" | "high" },\n            { "description": "Description of the second task", "effort": "low" | "medium" | "high" },\n            ...\n          ]\n        }\`\`\`
        
        **IMPORTANT:** Respond *only* with the valid JSON object conforming to one of the two cases described above. Do not include any introductory text, concluding remarks, or markdown formatting outside the JSON structure.`

      // Log truncated structured prompt for history
      await addHistoryEntry(featureId, 'model', {
        step: 'structured_planning_prompt',
        prompt: `Generate structured plan or clarification for: "${feature_description}" ${
          codebaseContext ? '(with context)' : '(no context)'
        }...`,
      })

      if ('chat' in planningModel) {
        // It's OpenRouter - Use structured output
        const structuredResult = await aiService.callOpenRouterWithSchema(
          OPENROUTER_MODEL,
          [{ role: 'user', content: structuredPlanningPrompt }],
          PlanFeatureResponseSchema,
          { temperature: 0.7 }
        )

        logToFile(
          `[TaskServer] Structured result (OpenRouter): ${JSON.stringify(
            structuredResult
          )}`
        )

        if (structuredResult.success) {
          // Check if clarification is needed
          if (structuredResult.data.clarificationNeeded) {
            logToFile(
              '[TaskServer] Clarification needed based on structured response.'
            )
            const clarification = structuredResult.data.clarificationNeeded

            // Open the browser *now* to show the question
            try {
              logToFile(`[TaskServer] Launching UI for clarification: ${uiUrl}`)
              const open = await dynamicImportDefault('open')
              await open(uiUrl)
              browserOpened = true // Mark browser as opened
              logToFile(
                '[TaskServer] Browser launch for clarification initiated.'
              )
            } catch (openError: any) {
              logToFile(
                `[TaskServer] Error launching browser for clarification: ${openError.message}`
              )
              // Continue even if browser launch fails, WS should still work if UI is open
            }

            // Store the intermediate state
            const questionId =
              await planningStateService.storeIntermediateState(
                featureId,
                structuredPlanningPrompt,
                JSON.stringify(structuredResult.data),
                'feature_planning'
              )
            // Send WebSocket message
            webSocketService.broadcast({
              type: 'show_question',
              featureId,
              payload: {
                questionId,
                question: clarification.question,
                options: clarification.options,
                allowsText: clarification.allowsText,
              },
            })
            // Record in history
            await addHistoryEntry(featureId, 'tool_response', {
              tool: 'plan_feature',
              status: 'awaiting_clarification',
              questionId,
            })
            // Return structured clarification info *serialized as text*
            const clarificationData = {
              questionId: questionId,
              question: clarification.question,
              options: clarification.options,
              allowsText: clarification.allowsText,
            }
            const clarificationResponse: PlanFeatureStandardResponse = {
              status: 'awaiting_clarification',
              message: `Planning paused for feature ${featureId}. User clarification needed via UI (${uiUrl}). Once submitted, call 'get_next_task' with featureId '${featureId}' to retrieve the first task.`,
              featureId: featureId,
              data: clarificationData,
              uiUrl: uiUrl,
            }
            return {
              // Serialize the standard response structure
              content: [
                { type: 'text', text: JSON.stringify(clarificationResponse) },
              ],
              isError: false, // Not an error, just waiting
            }
          } else if (structuredResult.data.tasks) {
            logToFile('[TaskServer] Tasks received in structured response.')
            // Convert the structured response to the expected format for processing
            planSteps = structuredResult.data.tasks.map(
              (task) => `[${task.effort}] ${task.description}`
            )
            await addHistoryEntry(featureId, 'model', {
              step: 'structured_planning_response',
              response: JSON.stringify(structuredResult.data),
            })
          } else {
            // Schema validation should prevent this, but handle defensively
            throw new Error(
              'Structured response valid but contained neither tasks nor clarification.'
            )
          }
        } else {
          // Fallback to unstructured response if structured fails
          console.warn(
            `[TaskServer] Structured planning failed: ${structuredResult.error}. Falling back to unstructured format.`
          )

          // Use traditional prompt and formatting
          const unstructuredFallbackPrompt = `${contextPromptPart}Generate a detailed, step-by-step coding implementation plan for the feature: "${feature_description}".
          
          The plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.
          
          For each coding task, include an effort rating (low, medium, or high) based on implementation work involved. High effort tasks often require breakdown.
          
          Use these effort definitions:
          - Low: Simple, quick changes in one or few files, minimal logic changes.
          - Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes.
          - High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring.
          
          IF YOU NEED CLARIFICATION BEFORE YOU CAN PROPERLY CREATE THE PLAN:
          Instead of returning a task list, use the following format to ask for clarification:
          [CLARIFICATION_NEEDED]
          Your specific question here. Be precise about what information you need to proceed.
          Options: [Option A, Option B, Option C] (include this line only if providing multiple-choice options)
          MULTIPLE_CHOICE_ONLY (include this if only the listed options are valid, omit if free text is also acceptable)
          [END_CLARIFICATION]
          
          For example:
          [CLARIFICATION_NEEDED]
          Should the feature implementation use SQL or NoSQL database for data storage?
          Options: [SQL, NoSQL]
          [END_CLARIFICATION]
          
          IF NO CLARIFICATION IS NEEDED:
          **IMPORTANT: Do NOT include any introductory sentences, summaries, concluding remarks, or any text other than the formatted task list itself. The response must start *directly* with the first task (e.g., "[low] Add console log...").**
          
          Now, generate the list of coding tasks, ensuring each task strictly follows this format: [effort] Task Description`

          let result = await planningModel.chat.completions.create({
            model: OPENROUTER_MODEL,
            messages: [{ role: 'user', content: unstructuredFallbackPrompt }],
            temperature: 0.7,
          })
          // We need to get the text response here for the old parsing logic to work
          let responseText = aiService.extractTextFromResponse(result)

          if (responseText === null) {
            message =
              'Error: Failed to get planning response from LLM or response was blocked. AI Agent: Do not try to call again. Simply alert the user.'
            isError = true
            // Record error in history, handling potential logging errors
            try {
              await addHistoryEntry(featureId, 'tool_response', {
                tool: 'plan_feature',
                isError: true,
                message,
                step: 'llm_response_processing',
              })
            } catch (historyError) {
              console.error(
                `[TaskServer] Failed to add error history entry during LLM processing failure: ${historyError}`
              )
            }
            return { content: [{ type: 'text', text: message }], isError }
          }

          // If no plan steps were extracted from structured response, try text parsing from fallback
          if (!planSteps.length && responseText) {
            logToFile(
              '[TaskServer] Attempting text parsing on unstructured fallback response.'
            )
            // IMPORTANT: Ensure parseGeminiPlanResponse ONLY extracts tasks and doesn't get confused by potential JSON remnants
            planSteps = parseGeminiPlanResponse(responseText)
            if (planSteps.length > 0) {
              logToFile(
                `[TaskServer] Extracted ${planSteps.length} tasks via text parsing.`
              )
            } else {
              // If still no tasks, log error and return *serialized*
              message =
                'Error: The planning model did not return a recognizable list of tasks.'
              isError = true
              // Record error in history, handling potential logging errors
              try {
                await addHistoryEntry(featureId, 'tool_response', {
                  tool: 'plan_feature',
                  isError: true,
                  message,
                  step: 'response_parsing',
                })
              } catch (historyError) {
                console.error(
                  `[TaskServer] Failed to add error history entry during response parsing failure: ${historyError}`
                )
              }
              const errorResponse: PlanFeatureStandardResponse = {
                status: 'error',
                message: message,
                featureId: featureId,
              }
              return {
                content: [
                  { type: 'text', text: JSON.stringify(errorResponse) },
                ],
                isError: true,
              }
            }
          }
        }
      } else {
        // It's Gemini - Use structured output
        const structuredResult = await aiService.callGeminiWithSchema(
          GEMINI_MODEL,
          structuredPlanningPrompt,
          PlanFeatureResponseSchema,
          { temperature: 0.7 }
        )

        logToFile(
          `[TaskServer] Structured result (Gemini): ${JSON.stringify(
            structuredResult
          )}`
        )

        if (structuredResult.success) {
          // Check if clarification is needed
          if (structuredResult.data.clarificationNeeded) {
            logToFile(
              '[TaskServer] Clarification needed based on structured response.'
            )
            const clarification = structuredResult.data.clarificationNeeded

            // Open the browser *now* to show the question
            try {
              logToFile(`[TaskServer] Launching UI for clarification: ${uiUrl}`)
              const open = await dynamicImportDefault('open')
              await open(uiUrl)
              browserOpened = true // Mark browser as opened
              logToFile(
                '[TaskServer] Browser launch for clarification initiated.'
              )
            } catch (openError: any) {
              logToFile(
                `[TaskServer] Error launching browser for clarification: ${openError.message}`
              )
              // Continue even if browser launch fails, WS should still work if UI is open
            }

            // Store the intermediate state
            const questionId =
              await planningStateService.storeIntermediateState(
                featureId,
                structuredPlanningPrompt,
                JSON.stringify(structuredResult.data),
                'feature_planning'
              )
            // Send WebSocket message
            webSocketService.broadcast({
              type: 'show_question',
              featureId,
              payload: {
                questionId,
                question: clarification.question,
                options: clarification.options,
                allowsText: clarification.allowsText,
              },
            })
            // Record in history
            await addHistoryEntry(featureId, 'tool_response', {
              tool: 'plan_feature',
              status: 'awaiting_clarification',
              questionId,
            })
            // Return structured clarification info *serialized as text*
            const clarificationData = {
              questionId: questionId,
              question: clarification.question,
              options: clarification.options,
              allowsText: clarification.allowsText,
            }
            const clarificationResponse: PlanFeatureStandardResponse = {
              status: 'awaiting_clarification',
              message: `Planning paused for feature ${featureId}. User clarification needed via UI (${uiUrl}). Once submitted, call 'get_next_task' with featureId '${featureId}' to retrieve the first task.`,
              featureId: featureId,
              data: clarificationData,
              uiUrl: uiUrl,
            }
            return {
              // Serialize the standard response structure
              content: [
                { type: 'text', text: JSON.stringify(clarificationResponse) },
              ],
              isError: false, // Not an error, just waiting
            }
          } else if (structuredResult.data.tasks) {
            logToFile('[TaskServer] Tasks received in structured response.')
            // Convert the structured response to the expected format for processing
            planSteps = structuredResult.data.tasks.map(
              (task) => `[${task.effort}] ${task.description}`
            )
            await addHistoryEntry(featureId, 'model', {
              step: 'structured_planning_response',
              response: JSON.stringify(structuredResult.data),
            })
          } else {
            // Schema validation should prevent this, but handle defensively
            throw new Error(
              'Structured response valid but contained neither tasks nor clarification.'
            )
          }
        } else {
          // Fallback to unstructured response if structured fails
          console.warn(
            `[TaskServer] Structured planning failed: ${structuredResult.error}. Falling back to unstructured format.`
          )

          // Use traditional Gemini call
          const unstructuredFallbackPrompt = `${contextPromptPart}Generate a detailed, step-by-step coding implementation plan for the feature: "${feature_description}".
          
          The plan should ONLY include actionable tasks a developer needs to perform within the code. Exclude steps related to project management, deployment, manual testing, documentation updates, or obtaining approvals.
          
          For each coding task, include an effort rating (low, medium, or high) based on implementation work involved. High effort tasks often require breakdown.
          
          Use these effort definitions:
          - Low: Simple, quick changes in one or few files, minimal logic changes.
          - Medium: Requires moderate development time, involves changes across several files/components, includes writing new functions/classes.
          - High: Significant development time, complex architectural changes, intricate algorithms, deep refactoring.
          
          IF YOU NEED CLARIFICATION BEFORE YOU CAN PROPERLY CREATE THE PLAN:
          Instead of returning a task list, use the following format to ask for clarification:
          [CLARIFICATION_NEEDED]
          Your specific question here. Be precise about what information you need to proceed.
          Options: [Option A, Option B, Option C] (include this line only if providing multiple-choice options)
          MULTIPLE_CHOICE_ONLY (include this if only the listed options are valid, omit if free text is also acceptable)
          [END_CLARIFICATION]
          
          For example:
          [CLARIFICATION_NEEDED]
          Should the feature implementation use SQL or NoSQL database for data storage?
          Options: [SQL, NoSQL]
          [END_CLARIFICATION]
          
          IF NO CLARIFICATION IS NEEDED:
          **IMPORTANT: Do NOT include any introductory sentences, summaries, concluding remarks, or any text other than the formatted task list itself. The response must start *directly* with the first task (e.g., "[low] Add console log...").**
          
          Now, generate the list of coding tasks, ensuring each task strictly follows this format: [effort] Task Description`

          let result = await planningModel.generateContent({
            contents: [
              { role: 'user', parts: [{ text: unstructuredFallbackPrompt }] },
            ],
            generationConfig: {
              temperature: 0.7,
            },
          })
          // We need to get the text response here for the old parsing logic to work
          let responseText = aiService.extractTextFromResponse(result)

          if (responseText === null) {
            message =
              'Error: Failed to get planning response from LLM or response was blocked. AI Agent: Do not try to call again. Simply alert the user.'
            isError = true
            // Record error in history, handling potential logging errors
            try {
              await addHistoryEntry(featureId, 'tool_response', {
                tool: 'plan_feature',
                isError: true,
                message,
                step: 'llm_response_processing',
              })
            } catch (historyError) {
              console.error(
                `[TaskServer] Failed to add error history entry during LLM processing failure: ${historyError}`
              )
            }
            return { content: [{ type: 'text', text: message }], isError }
          }

          // If no plan steps were extracted from structured response, try text parsing from fallback
          if (!planSteps.length && responseText) {
            logToFile(
              '[TaskServer] Attempting text parsing on unstructured fallback response.'
            )
            // IMPORTANT: Ensure parseGeminiPlanResponse ONLY extracts tasks and doesn't get confused by potential JSON remnants
            planSteps = parseGeminiPlanResponse(responseText)
            if (planSteps.length > 0) {
              logToFile(
                `[TaskServer] Extracted ${planSteps.length} tasks via text parsing.`
              )
            } else {
              // If still no tasks, log error and return *serialized*
              message =
                'Error: The planning model did not return a recognizable list of tasks.'
              isError = true
              // Record error in history, handling potential logging errors
              try {
                await addHistoryEntry(featureId, 'tool_response', {
                  tool: 'plan_feature',
                  isError: true,
                  message,
                  step: 'response_parsing',
                })
              } catch (historyError) {
                console.error(
                  `[TaskServer] Failed to add error history entry during response parsing failure: ${historyError}`
                )
              }
              const errorResponse: PlanFeatureStandardResponse = {
                status: 'error',
                message: message,
                featureId: featureId,
              }
              return {
                content: [
                  { type: 'text', text: JSON.stringify(errorResponse) },
                ],
                isError: true,
              }
            }
          }
        }
      }

      // Process the plan steps using the centralized function
      const finalTasks = await processAndFinalizePlan(
        planSteps, // Use the extracted/parsed plan steps
        planningModel,
        featureId
      )

      task_count = finalTasks.length

      message = `Successfully planned feature '${feature_description}' with ${task_count} tasks.`
      logToFile(`[TaskServer] ${message}`)

      // Record final success in history
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        status: 'completed',
        taskCount: task_count,
      })
    } catch (error: any) {
      message = `Error during feature planning: ${error.message}`
      isError = true
      await logToFile(`[TaskServer] ${message} Stack: ${error.stack}`)

      // Record error in history, handling potential logging errors
      try {
        await addHistoryEntry(featureId, 'tool_response', {
          tool: 'plan_feature',
          isError: true,
          message: error.message,
          step: 'planning_execution', // Indicate where the error occurred
        })
      } catch (historyError) {
        console.error(
          `[TaskServer] Failed to add error history entry during planning execution failure: ${historyError}`
        )
      }
    }
  } catch (outerError: any) {
    // Catch errors happening before LLM call (e.g., history writing)
    message = `An unexpected error occurred: ${outerError.message}`
    isError = true
    await logToFile(
      `[TaskServer] Unexpected error in handlePlanFeature: ${outerError.stack}`
    )
    // Attempt to record history if possible
    try {
      await addHistoryEntry(featureId, 'tool_response', {
        tool: 'plan_feature',
        isError: true,
        message: outerError.message,
        step: 'pre_planning_error',
      })
    } catch (historyError) {
      await logToFile(
        `[TaskServer] Failed to record history entry for outer error: ${historyError}`
      )
    }
    // Ensure even outer errors return the standard structure
    const errorResponse: PlanFeatureStandardResponse = {
      status: 'error',
      message: message,
      featureId: featureId, // Include featureId if available
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(errorResponse) }],
      isError: true,
    }
  }

  // Open the UI in the browser *if not already opened for clarification*
  if (!browserOpened) {
    try {
      await logToFile(
        `[TaskServer] Planning complete/failed. Launching UI: ${uiUrl}`
      )
      const open = await dynamicImportDefault('open')
      await open(uiUrl)
      await logToFile('[TaskServer] Browser launch initiated successfully')
    } catch (openError: any) {
      await logToFile(
        `[TaskServer] Error launching browser post-process: ${openError.message}`
      )
      // Continue even if browser launch fails
    }
  }

  // Prepare the final return content *as standard response object*
  let responseData: PlanFeatureStandardResponse
  if (!isError && task_count && task_count > 0) {
    let firstTaskDesc: string | undefined
    try {
      let updatedTasks: Task[] = []

      // Use databaseService instead of readTasks
      await databaseService.connect()
      updatedTasks = await databaseService.getTasksByFeatureId(featureId)
      await databaseService.close()

      if (updatedTasks.length > 0) {
        const firstTask = updatedTasks[0]
        // Format the first task for the return message
        firstTaskDesc = firstTask.description // Store first task desc
      } else {
        // Fallback if tasks array is somehow empty after successful planning
        firstTaskDesc = undefined
      }
    } catch (readError) {
      logToFile(
        `[TaskServer] Error reading tasks after finalization: ${readError}`
      )
      // Fallback to the original message if reading fails
      firstTaskDesc = undefined
    }

    // Construct success response
    responseData = {
      status: 'completed',
      message: `Successfully planned ${task_count || 0} tasks.${
        firstTaskDesc ? ' First task: "' + firstTaskDesc + '"' : ''
      }`,
      featureId: featureId,
      uiUrl: uiUrl,
    }
  } else {
    // Construct error or no-tasks response
    responseData = {
      status: isError ? 'error' : 'completed', // 'completed' but with 0 tasks is possible
      message: message, // Use the message determined earlier (could be error or success-with-0-tasks)
      featureId: featureId,
      uiUrl: uiUrl,
    }
  }

  // Final return structure using the standard serialized format
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(responseData),
      },
    ],
    isError, // Keep isError consistent with internal state for SDK
  }
}
