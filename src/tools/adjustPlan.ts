import { z } from 'zod'
import {
  AdjustPlanInputSchema,
  HistoryEntry,
  PlanFeatureResponseSchema,
  Task,
  TaskListSchema,
} from '../models/types' // Assuming types.ts is in ../models
import {
  readTasks,
  writeTasks,
  readHistory,
  addHistoryEntry,
} from '../lib/fsUtils' // Corrected path for history utils as well
import { aiService } from '../services/aiService' // Import aiService
import webSocketService from '../services/webSocketService' // Import the service instance
import { OPENROUTER_MODEL } from '../config' // Assuming model config is here
import {
  ensureEffortRatings,
  processAndBreakdownTasks,
  detectClarificationRequest,
  processAndFinalizePlan,
} from '../lib/llmUtils' // Import the refactored utils
import { GenerativeModel } from '@google/generative-ai' // Import types for model
import OpenAI from 'openai' // Import OpenAI
import planningStateService from '../services/planningStateService'

// Placeholder for the actual prompt construction logic
async function constructAdjustmentPrompt(
  originalRequest: string, // Need to retrieve this
  currentTasks: any[], // Type according to TaskListSchema
  history: any[], // Type according to FeatureHistorySchema
  adjustmentRequest: string
): Promise<string> {
  // TODO: Implement detailed prompt engineering here
  // Include original request, current task list, relevant history, and the adjustment request
  // Provide clear instructions for the LLM to output a revised task list in the correct format.
  console.log('Constructing adjustment prompt...')
  const prompt = `
Original Feature Request:
${originalRequest}

Current Task List:
${JSON.stringify(currentTasks, null, 2)}

Relevant Conversation History:
${JSON.stringify(history.slice(-5), null, 2)} // Example: last 5 entries

User Adjustment Request:
${adjustmentRequest}

Instructions:
Review the original request, current tasks, history, and the user's adjustment request.
Output a *revised* and *complete* task list based on the adjustment request.
The revised list should incorporate the requested changes (additions, removals, modifications, reordering).
Maintain the same JSON format as the 'Current Task List' shown above.
Ensure all tasks have necessary fields (id, description, status, effort, etc.). If IDs need regeneration, use UUID format. Preserve existing IDs where possible for unmodified tasks.
Output *only* the JSON object containing the revised task list under the key 'tasks', like this: { "tasks": [...] }.

IF YOU NEED CLARIFICATION BEFORE YOU CAN PROPERLY ADJUST THE PLAN:
1. Instead of returning a task list, use the following format to ask for clarification:
[CLARIFICATION_NEEDED]
Your specific question here. Be precise about what information you need to proceed.
Options: [Option A, Option B, Option C] (include this line only if providing multiple-choice options)
MULTIPLE_CHOICE_ONLY (include this if only the listed options are valid, omit if free text is also acceptable)
[END_CLARIFICATION]

For example:
[CLARIFICATION_NEEDED]
Should the authentication system use JWT or session-based authentication?
Options: [JWT, Session Cookies, OAuth2]
[END_CLARIFICATION]
`
  return prompt
}

// Updated to use refactored task processing logic
async function parseAndProcessLLMResponse(
  llmResult:
    | { success: true; data: z.infer<typeof PlanFeatureResponseSchema> }
    | { success: false; error: string },
  featureId: string,
  model: GenerativeModel | OpenAI | null // Pass the model instance
): Promise<Task[]> {
  console.log('Processing LLM response using refactored logic...')
  if (llmResult.success) {
    // Check if tasks exist before accessing
    if (!llmResult.data.tasks) {
      console.error(
        '[TaskServer] Error: parseAndProcessLLMResponse called but response contained clarificationNeeded instead of tasks.'
      )
      // Should not happen if adjustPlanHandler checks for clarification first, but handle defensively
      throw new Error(
        'parseAndProcessLLMResponse received clarification request, expected tasks.'
      )
    }
    // 1. Map LLM output to "[effort] description" strings
    const rawPlanSteps = llmResult.data.tasks.map(
      (task) => `[${task.effort}] ${task.description}`
    )

    // 2. Call the centralized function to process, finalize, save, and notify
    const finalTasks = await processAndFinalizePlan(
      rawPlanSteps,
      model,
      featureId
    )

    // Validation is handled inside processAndFinalizePlan, but we double-check the final output count
    if (finalTasks.length === 0 && rawPlanSteps.length > 0) {
      console.warn(
        '[TaskServer] Warning: LLM provided tasks, but processing resulted in an empty list.'
      )
      // Potentially throw an error or return empty based on desired behavior
    }

    console.log(`Processed LLM response into ${finalTasks.length} final tasks.`)
    return finalTasks
  } else {
    console.error('LLM call failed:', llmResult.error)
    throw new Error(`LLM failed to generate revised plan: ${llmResult.error}`)
  }
}

// The main handler function for the adjust_plan tool
export async function adjustPlanHandler(
  input: z.infer<typeof AdjustPlanInputSchema>
): Promise<{ status: string; message: string; tasks?: Task[] }> {
  const { featureId, adjustment_request } = input

  try {
    console.log(`Adjusting plan for feature ${featureId}`)

    // Get the planning model instance
    const planningModel = aiService.getPlanningModel() // Need the model instance
    if (!planningModel) {
      throw new Error('Planning model not available.')
    }

    // 1. Load current tasks and history
    const currentTasks = await readTasks(featureId)
    const history = await readHistory(featureId)
    // TODO: Retrieve the original feature request. This might need to be stored
    // alongside tasks or history, or retrieved from the initial history entry.
    const originalFeatureRequest =
      history.find(
        (entry: HistoryEntry) =>
          entry.role === 'user' &&
          typeof entry.content === 'string' &&
          entry.content.startsWith('Feature Request:')
      )?.content || 'Original request not found'

    // 2. Construct the prompt for the LLM
    const prompt = await constructAdjustmentPrompt(
      originalFeatureRequest,
      currentTasks,
      history,
      adjustment_request
    )

    // 3. Call the LLM using aiService with schema
    console.log('Calling LLM for plan adjustment via aiService...')
    const llmResult = await aiService.callOpenRouterWithSchema(
      OPENROUTER_MODEL, // Or choose GEMINI_MODEL
      [{ role: 'user', content: prompt }],
      PlanFeatureResponseSchema, // Expecting this structure back
      { temperature: 0.3 } // Adjust parameters as needed
    )

    // Check for clarification requests in the LLM response
    if (llmResult.rawResponse) {
      const textContent = aiService.extractTextFromResponse(
        llmResult.rawResponse
      )
      if (textContent) {
        const clarificationCheck = detectClarificationRequest(textContent)

        if (clarificationCheck.detected) {
          // Store the intermediate state
          const questionId = planningStateService.storeIntermediateState(
            featureId,
            prompt,
            clarificationCheck.rawResponse,
            'plan_adjustment'
          )

          // Send WebSocket message to UI asking for clarification
          webSocketService.broadcast({
            type: 'show_question',
            featureId,
            payload: {
              questionId,
              question: clarificationCheck.clarificationRequest.question,
              options: clarificationCheck.clarificationRequest.options,
              allowsText: clarificationCheck.clarificationRequest.allowsText,
            },
          })

          // Record in history
          await addHistoryEntry(featureId, 'tool_response', {
            tool: 'adjust_plan',
            status: 'awaiting_clarification',
            questionId,
          })

          return {
            status: 'awaiting_clarification',
            message: `Plan adjustment paused for feature ${featureId}. User clarification needed via UI. Once submitted, call 'get_next_task' with featureId '${featureId}' to retrieve the first task.`,
          }
        }
      }
    }

    // 4. Process the LLM response (this now handles finalization, saving, notification)
    const revisedTasks = await parseAndProcessLLMResponse(
      llmResult,
      featureId,
      planningModel
    )

    // 5. Add history entries (saving and notification are handled within parseAndProcessLLMResponse -> processAndFinalizePlan)
    await addHistoryEntry(
      featureId,
      'tool_call',
      `Adjust plan request: ${adjustment_request}`
    )
    await addHistoryEntry(featureId, 'tool_response', {
      tool: 'adjust_plan',
      status: 'completed',
      taskCount: revisedTasks.length,
    })

    // 6. Return confirmation
    return {
      status: 'success',
      message: `Successfully adjusted the plan for feature ${featureId}.`,
      tasks: revisedTasks,
    }
  } catch (error: any) {
    console.error(`Error adjusting plan for feature ${featureId}:`, error)
    // Broadcast error using the service
    webSocketService.broadcast({
      type: 'error',
      featureId: featureId,
      payload: { code: 'PLAN_ADJUST_FAILED', message: error.message },
    })
    await addHistoryEntry(featureId, 'tool_response', {
      tool: 'adjust_plan',
      status: 'failed',
      error: error.message,
    })
    return {
      status: 'error',
      message: `Error adjusting plan: ${error.message}`,
    }
  }
}

// Example usage (for testing purposes)
/*
async function testAdjustPlan() {
  const testInput = {
    featureId: 'your-test-feature-id', // Replace with a valid UUID from your data
    adjustment_request: 'Please add a new task for setting up logging after the initial setup task, and remove the task about documentation.',
  };

  // Ensure you have dummy files like 'your-test-feature-id_mcp_tasks.json'
  // and 'your-test-feature-id_mcp_history.json' in your data directory.

  try {
    const result = await adjustPlanHandler(testInput);
    console.log('Adjustment Result:', result);
  } catch (error) {
    console.error('Adjustment Test Failed:', error);
  }
}

// testAdjustPlan(); // Uncomment to run test
*/
