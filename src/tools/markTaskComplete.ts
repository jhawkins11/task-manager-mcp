import { Task } from '../models/types'
import { readTasks, writeTasks, addHistoryEntry } from '../lib/fsUtils'
import { logToFile } from '../lib/logger'

interface MarkTaskCompleteParams {
  task_id: string
  feature_id: string
}

interface MarkTaskCompleteResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Handles the mark_task_complete tool request
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
          // Auto-complete the parent task
          const finalTasks = updatedTasks.map((task) => {
            if (task.id === parentTaskId) {
              console.error(
                `[TaskServer] Auto-completing parent task ${parentTaskId} as all subtasks are complete.`
              )
              return { ...task, status: 'completed' as const }
            }
            return task
          })

          await writeTasks(feature_id, finalTasks)
          await logToFile(
            `[TaskServer] Task ${task_id} and parent task marked as complete.`
          )
          message = `Task ${task_id} marked as complete. Parent task ${parentTaskId} also auto-completed as all subtasks are now complete.`

          // Record success with parent completion in history
          await addHistoryEntry(feature_id, 'tool_response', {
            tool: 'mark_task_complete',
            isError: false,
            message,
            taskId: task_id,
            parentTaskId,
            status: 'completed_with_parent',
          })

          return { content: [{ type: 'text', text: message }] }
        }
      }

      // Pass the correctly mapped array directly
      await writeTasks(feature_id, updatedTasks)
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
    return {
      content: [{ type: 'text', text: message }],
      isError: isError,
    }
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
