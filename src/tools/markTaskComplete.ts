import { Task } from '../models/types'
import { readTasks, writeTasks, addHistoryEntry } from '../lib/fsUtils'
import { logToFile } from '../lib/logger'
import webSocketService from '../services/webSocketService'

interface MarkTaskCompleteParams {
  task_id: string
  feature_id: string
}

interface MarkTaskCompleteResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Handles the mark_task_complete tool request and returns the next task
 */
export async function handleMarkTaskComplete(
  params: MarkTaskCompleteParams
): Promise<MarkTaskCompleteResult> {
  const { task_id, feature_id } = params

  await logToFile(
    `[TaskServer] Handling mark_task_complete request for ID: ${task_id} in feature: ${feature_id}`
  )

  try {
    // Record tool call in history
    await addHistoryEntry(feature_id, 'tool_call', {
      tool: 'mark_task_complete',
      params: { task_id, feature_id },
    })

    const tasks = await readTasks(feature_id)
    let taskFound = false
    let alreadyCompleted = false
    let isSubtask = false
    let parentTaskId: string | undefined = undefined

    const updatedTasks = tasks.map((task) => {
      if (task.id === task_id) {
        taskFound = true
        if (task.status === 'completed') {
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

    if (tasks.length === 0) {
      await logToFile(
        `[TaskServer] No tasks found for feature ID: ${feature_id}`
      )
      message = `Error: No tasks found for feature ID ${feature_id}. The feature may not exist or has not been planned yet.`
      isError = true

      // Record error in history
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: true,
        message,
      })

      return { content: [{ type: 'text', text: message }], isError }
    }

    if (!taskFound) {
      await logToFile(
        `[TaskServer] Task ${task_id} not found in feature: ${feature_id}`
      )
      message = `Error: Task with ID ${task_id} not found in feature ${feature_id}.`
      isError = true

      // Record error in history
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: true,
        message,
      })

      return { content: [{ type: 'text', text: message }], isError }
    } else if (alreadyCompleted) {
      message = `Task ${task_id} was already marked as complete.`

      // Record "already completed" response in history
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: false,
        message,
        taskId: task_id,
        status: 'already_completed',
      })
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
          // Auto-update the parent task status to 'decomposed'
          const finalTasks = updatedTasks.map((task) => {
            if (task.id === parentTaskId) {
              console.error(
                `[TaskServer] Setting parent task ${parentTaskId} to 'decomposed' as all subtasks are complete.`
              )
              // Parent is decomposed, not completed
              return {
                ...task,
                status: 'decomposed' as const,
                completed: false,
              }
            }
            return task
          })

          await writeTasks(feature_id, finalTasks)

          // Broadcast task updates via WebSocket
          try {
            webSocketService.notifyTasksUpdated(feature_id, finalTasks)
            webSocketService.notifyTaskStatusChanged(
              feature_id,
              task_id,
              'completed' // The subtask itself is completed
            )
            webSocketService.notifyTaskStatusChanged(
              feature_id,
              parentTaskId!,
              'decomposed' // Parent is now decomposed
            )
            await logToFile(
              `[TaskServer] Broadcast tasks_updated and status_changed events for feature ${feature_id}`
            )
          } catch (wsError) {
            await logToFile(
              `[TaskServer] Warning: Failed to broadcast task update: ${wsError}`
            )
            // Don't fail the operation if WebSocket broadcast fails
          }

          await logToFile(
            `[TaskServer] Task ${task_id} marked as complete. Parent task ${parentTaskId} status set to decomposed.`
          )
          message = `Task ${task_id} marked as complete. Parent task ${parentTaskId} status updated as all subtasks are now complete.`

          // Record success with parent update in history
          await addHistoryEntry(feature_id, 'tool_response', {
            tool: 'mark_task_complete',
            isError: false,
            message,
            taskId: task_id,
            parentTaskId,
            status: 'completed_with_parent_decomposed', // Updated status key
          })

          // Now find the next task (using the finalTasks list)
          return getNextTaskAfterCompletion(finalTasks, message, feature_id)
        }
      }

      // Pass the correctly mapped array directly
      await writeTasks(feature_id, updatedTasks)

      // Broadcast task updates via WebSocket
      try {
        webSocketService.notifyTasksUpdated(feature_id, updatedTasks)
        webSocketService.notifyTaskStatusChanged(
          feature_id,
          task_id,
          'completed'
        )
        await logToFile(
          `[TaskServer] Broadcast tasks_updated and status_changed events for feature ${feature_id}`
        )
      } catch (wsError) {
        await logToFile(
          `[TaskServer] Warning: Failed to broadcast task update: ${wsError}`
        )
        // Don't fail the operation if WebSocket broadcast fails
      }

      await logToFile(`[TaskServer] Task ${task_id} marked as complete.`)
      message = `Task ${task_id} marked as complete.`

      // Record success in history
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: false,
        message,
        taskId: task_id,
        status: 'completed',
      })
    }

    // Find the next task after completion
    return getNextTaskAfterCompletion(updatedTasks, message, feature_id)
  } catch (error) {
    const errorMsg = `Error processing mark_task_complete request: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(`[TaskServer] ${errorMsg}`)

    // Record error in history
    try {
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'mark_task_complete',
        isError: true,
        message: errorMsg,
        taskId: task_id,
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error),
      })
    } catch (historyError) {
      console.error(
        `[TaskServer] Failed to record error in history: ${historyError}`
      )
    }

    return {
      content: [{ type: 'text', text: errorMsg }],
      isError: true,
    }
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

  if (!nextTask) {
    await logToFile(
      `[TaskServer] No pending tasks remaining for feature ID: ${featureId}`
    )
    const message = `${completionMessage}\n\nAll tasks have been completed for this feature.`

    // Record completion in history
    await addHistoryEntry(featureId, 'tool_response', {
      tool: 'mark_task_complete',
      isError: false,
      message,
      status: 'all_completed',
    })

    return {
      content: [{ type: 'text', text: message }],
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
