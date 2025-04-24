import { Task } from '../models/types'
import { logToFile } from '../lib/logger'
import webSocketService from '../services/webSocketService'
import { databaseService } from '../services/databaseService'
import { addHistoryEntry } from '../lib/dbUtils'
import { AUTO_REVIEW_ON_COMPLETION } from '../config'
import { handleReviewChanges } from '../tools/reviewChanges'

interface MarkTaskCompleteParams {
  task_id: string
  feature_id: string
}

interface MarkTaskCompleteResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Maps database task objects (with snake_case properties) to application Task objects (with camelCase)
 */
function mapDatabaseTaskToAppTask(dbTask: any): Task {
  return {
    ...dbTask,
    feature_id: dbTask.feature_id,
    parentTaskId: dbTask.parent_task_id,
  }
}

/**
 * Handles the mark_task_complete tool request and returns the next task
 */
export async function handleMarkTaskComplete(
  params: MarkTaskCompleteParams
): Promise<MarkTaskCompleteResult> {
  const { task_id, feature_id } = params
  let message: string = ''
  let isError = false
  let finalTasks: Task[] = [] // Hold the final state of tasks for reporting
  let taskStatusUpdate: any = { isError: false, status: 'unknown' }

  await logToFile(
    `[TaskServer] Handling mark_task_complete request for ID: ${task_id} in feature: ${feature_id}`
  )

  // Record initial tool call attempt
  try {
    await addHistoryEntry(feature_id, 'tool_call', {
      tool: 'mark_task_complete',
      params: { task_id, feature_id },
    })
  } catch (historyError) {
    console.error(
      `[TaskServer] Failed to add initial history entry: ${historyError}`
    )
    // Potentially return error here if initial logging is critical
    // For now, we log and continue
  }

  try {
    // --- Database Operations Block ---
    await databaseService.connect()
    try {
      const dbTasks = await databaseService.getTasksByFeatureId(feature_id)
      const tasks = dbTasks.map(mapDatabaseTaskToAppTask)
      finalTasks = [...tasks] // Initialize finalTasks with current state

      if (tasks.length === 0) {
        message = `Error: No tasks found for feature ID ${feature_id}.`
        isError = true
        taskStatusUpdate = { isError: true, status: 'feature_not_found' }
        // No further DB ops needed, exit the inner try block
      } else {
        const taskIndex = tasks.findIndex((task) => task.id === task_id)
        if (taskIndex === -1) {
          message = `Error: Task with ID ${task_id} not found in feature ${feature_id}.`
          isError = true
          taskStatusUpdate = { isError: true, status: 'task_not_found' }
        } else {
          const taskToUpdate = tasks[taskIndex]
          if (taskToUpdate.status === 'completed') {
            message = `Task ${task_id} was already marked as complete.`
            isError = false // Not an error, just informational
            taskStatusUpdate = {
              isError: false,
              status: 'already_completed',
              taskId: task_id,
            }
            // No DB update needed, but update finalTasks for consistency
            finalTasks = [...tasks]
          } else {
            // Mark the task as completed locally first for checks
            finalTasks = tasks.map((task) =>
              task.id === task_id
                ? { ...task, status: 'completed' as const }
                : task
            )

            // Perform the actual database update for the main task
            await databaseService.updateTaskStatus(task_id, 'completed', true)
            message = `Task ${task_id} marked as complete.`
            taskStatusUpdate = {
              isError: false,
              status: 'completed',
              taskId: task_id,
            }
            logToFile(
              `[TaskServer] Task ${task_id} DB status updated to completed.`
            )

            // Check for parent task completion
            if (taskToUpdate.parentTaskId) {
              const parentId = taskToUpdate.parentTaskId
              const siblingTasks = finalTasks.filter(
                (t) => t.parentTaskId === parentId && t.id !== task_id // Exclude current task if needed, already marked completed
              )
              const allSubtasksComplete = siblingTasks.every(
                (st) => st.status === 'completed'
              )

              if (allSubtasksComplete) {
                logToFile(
                  `[TaskServer] All subtasks for parent ${parentId} complete. Updating parent.`
                )
                await databaseService.updateTaskStatus(
                  parentId,
                  'decomposed',
                  false
                )
                // Update parent status in our finalTasks list as well
                finalTasks = finalTasks.map((task) =>
                  task.id === parentId
                    ? { ...task, status: 'decomposed' as const }
                    : task
                )
                message += ` Parent task ${parentId} status updated as all subtasks are now complete.`
                taskStatusUpdate = {
                  isError: false,
                  status: 'completed_with_parent_decomposed',
                  taskId: task_id,
                  parentTaskId: parentId,
                }
                logToFile(
                  `[TaskServer] Parent task ${parentId} DB status updated to decomposed.`
                )
              }
            }

            // Fetch final state *after* all updates
            const dbFinalState = await databaseService.getTasksByFeatureId(
              feature_id
            )
            finalTasks = dbFinalState.map(mapDatabaseTaskToAppTask)
            logToFile(`[TaskServer] Final task state fetched after updates.`)
          }
        }
      }
    } finally {
      // Ensure DB connection is closed
      try {
        await databaseService.close()
        logToFile(`[TaskServer] Database connection closed successfully.`)
      } catch (closeError) {
        console.error(
          `[TaskServer] Error closing database connection: ${closeError}`
        )
        // Don't mask the original error if one occurred
        if (!isError) {
          message = `Error closing database: ${closeError}`
          isError = true
          taskStatusUpdate = { isError: true, status: 'db_close_error' }
        }
      }
    }
    // --- End Database Operations Block ---

    // --- Post-DB Operations (History, WS, Response) ---

    // Broadcast updates via WebSocket if DB ops were successful (or partially successful)
    if (
      taskStatusUpdate.status !== 'unknown' &&
      taskStatusUpdate.status !== 'feature_not_found' &&
      taskStatusUpdate.status !== 'task_not_found'
    ) {
      try {
        webSocketService.notifyTasksUpdated(feature_id, finalTasks)
        if (
          taskStatusUpdate.status === 'completed' ||
          taskStatusUpdate.status === 'completed_with_parent_decomposed'
        ) {
          webSocketService.notifyTaskStatusChanged(
            feature_id,
            task_id,
            'completed'
          )
        }
        if (
          taskStatusUpdate.status === 'completed_with_parent_decomposed' &&
          taskStatusUpdate.parentTaskId
        ) {
          webSocketService.notifyTaskStatusChanged(
            feature_id,
            taskStatusUpdate.parentTaskId,
            'decomposed'
          )
        }
        logToFile(
          `[TaskServer] Broadcast WebSocket events for feature ${feature_id}`
        )
      } catch (wsError) {
        logToFile(
          `[TaskServer] Warning: Failed to broadcast task update: ${wsError}`
        )
        // Don't fail the overall operation
      }
    }

    // Record final outcome in history
    try {
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: isError,
        message: message,
        ...taskStatusUpdate, // Add status details
      })
    } catch (historyError) {
      console.error(
        `[TaskServer] Failed to add final history entry: ${historyError}`
      )
      // If history fails here, the main operation still succeeded or failed as determined before
    }

    // If there was an error identified during DB ops, return error now
    if (isError) {
      return { content: [{ type: 'text', text: message }], isError: true }
    }

    // If successful, find and return the next task
    return getNextTaskAfterCompletion(finalTasks, message, feature_id)
  } catch (error) {
    // Catch errors from the main DB block or other unexpected issues
    const errorMsg = `Error processing mark_task_complete request: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(`[TaskServer] ${errorMsg}`, error)
    isError = true
    message = errorMsg

    // Record error in history (attempt)
    try {
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: true,
        message: errorMsg,
        error: error instanceof Error ? error.message : String(error),
        status: 'processing_error',
      })
    } catch (historyError) {
      console.error(
        `[TaskServer] Failed to add error history entry during failure: ${historyError}`
      )
    }

    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

/**
 * Gets the next task after completion and formats the response with both completion message and next task info
 */
async function getNextTaskAfterCompletion(
  tasks: Task[],
  completionMessage: string,
  featureId: string
): Promise<MarkTaskCompleteResult> {
  // Find the first pending task in the list
  const nextTask = tasks.find((task) => task.status === 'pending')

  // Prevent infinite review loop: only trigger review if there are no review tasks yet
  const hasReviewTasks = tasks.some((task) => task.fromReview)

  if (!nextTask) {
    await logToFile(
      `[TaskServer] No pending tasks remaining for feature ID: ${featureId}. Completion message: "${completionMessage}"`
    )

    let finalMessage = `${completionMessage}\n\nAll tasks have been completed for this feature.`
    const historyPayload: any = {
      tool: 'mark_task_complete',
      isError: false,
      message: finalMessage, // Keep original message for history initially
      status: 'all_completed',
    }
    let resultPayload: any = [{ type: 'text', text: finalMessage }]

    // Only trigger auto-review if there are no review tasks yet
    if (AUTO_REVIEW_ON_COMPLETION && !hasReviewTasks) {
      await logToFile(
        `[TaskServer] Auto-review enabled for feature ${featureId}. Initiating review.`
      )
      historyPayload.status = 'all_completed_auto_review_started' // Update history status
      historyPayload.autoReviewTriggered = true

      try {
        // Call handleReviewChanges to generate and save review tasks
        const reviewResult = await handleReviewChanges({ featureId: featureId })

        if (reviewResult.isError) {
          finalMessage += `\n\nAuto-review failed: ${
            reviewResult.content[0]?.text || 'Unknown error'
          }`
          historyPayload.isError = true
          historyPayload.reviewError = reviewResult.content[0]?.text
          logToFile(
            `[TaskServer] Auto-review process failed for ${featureId}: ${reviewResult.content[0]?.text}`
          )
        } else {
          // Review succeeded, tasks were added (or no tasks were needed)
          logToFile(
            `[TaskServer] Auto-review process completed for ${featureId}. Fetching updated tasks...`
          )

          // Fetch the updated task list including any new review tasks
          let updatedTasks: Task[] = []
          try {
            await databaseService.connect()
            const dbFinalState = await databaseService.getTasksByFeatureId(
              featureId
            )
            updatedTasks = dbFinalState.map(mapDatabaseTaskToAppTask)
            await databaseService.close()
            logToFile(
              `[TaskServer] Fetched ${updatedTasks.length} total tasks for ${featureId} after review.`
            )

            // Notify UI with the updated task list
            webSocketService.notifyTasksUpdated(featureId, updatedTasks)
            logToFile(
              `[TaskServer] Sent tasks_updated notification for ${featureId} after review.`
            )

            finalMessage += `\n\nAuto-review completed. Review tasks may have been added.`
            historyPayload.status = 'all_completed_auto_review_finished' // Update history status
            historyPayload.reviewResult = reviewResult.content[0]?.text // Log the original review result text
          } catch (dbError) {
            const dbErrorMsg = `Error fetching/updating tasks after review: ${
              dbError instanceof Error ? dbError.message : String(dbError)
            }`
            logToFile(`[TaskServer] ${dbErrorMsg}`)
            finalMessage += `\n\nAuto-review ran, but failed to update task list: ${dbErrorMsg}`
            historyPayload.isError = true // Mark history as error if fetching/notifying fails
            historyPayload.postReviewError = dbErrorMsg
          }
        }

        // Update the result payload with the final message
        resultPayload = [{ type: 'text', text: finalMessage }]
      } catch (reviewError) {
        const reviewErrorMsg = `Error during auto-review execution: ${
          reviewError instanceof Error
            ? reviewError.message
            : String(reviewError)
        }`
        logToFile(`[TaskServer] ${reviewErrorMsg}`)
        finalMessage += `\n\nAuto-review execution failed: ${reviewErrorMsg}`
        historyPayload.isError = true
        historyPayload.reviewExecutionError = reviewErrorMsg
        resultPayload = [{ type: 'text', text: finalMessage }]
      }
    }

    // Record completion/review trigger in history
    await addHistoryEntry(featureId, 'tool_response', historyPayload)

    return {
      content: resultPayload,
    }
  }

  // Found the next task
  await logToFile(`[TaskServer] Found next sequential task: ${nextTask.id}`)

  // Include effort in the message if available
  const effortInfo = nextTask.effort ? ` (Effort: ${nextTask.effort})` : ''

  // Include parent info if this is a subtask
  let parentInfo = ''
  if (nextTask.parentTaskId) {
    // Find the parent task
    const parentTask = tasks.find((t) => t.id === nextTask.parentTaskId)
    if (parentTask) {
      const parentDesc =
        (parentTask?.description?.length ?? 0) > 30
          ? (parentTask?.description?.substring(0, 30) ?? '') + '...'
          : parentTask?.description ?? ''
      parentInfo = ` (Subtask of: "${parentDesc}")`
    } else {
      parentInfo = ` (Subtask of parent ID: ${nextTask.parentTaskId})` // Fallback if parent not found
    }
  }

  // Embed ID, description, effort, and parent info in the text message
  const nextTaskMessage = `Next pending task (ID: ${nextTask.id})${effortInfo}${parentInfo}: ${nextTask.description}`

  // Combine completion message with next task info
  const message = `${completionMessage}\n\n${nextTaskMessage}`

  // Record in history
  await addHistoryEntry(featureId, 'tool_response', {
    tool: 'mark_task_complete',
    isError: false,
    message,
    nextTask: nextTask,
  })

  return {
    content: [{ type: 'text', text: message }],
  }
}
