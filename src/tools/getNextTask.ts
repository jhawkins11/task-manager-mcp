import { Task } from '../models/types'
import { readTasks } from '../lib/fsUtils'
import { addHistoryEntry } from '../lib/fsUtils'
import { logToFile } from '../lib/logger'

interface GetNextTaskParams {
  feature_id: string
}

interface GetNextTaskResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Handles the get_next_task tool request
 */
export async function handleGetNextTask(
  params: GetNextTaskParams
): Promise<GetNextTaskResult> {
  const { feature_id } = params

  await logToFile(
    `[TaskServer] Handling get_next_task request for feature: ${feature_id}`
  )

  try {
    // Record tool call in history
    await addHistoryEntry(feature_id, 'tool_call', {
      tool: 'get_next_task',
      params: { feature_id },
    })

    const tasks = await readTasks(feature_id)

    if (tasks.length === 0) {
      await logToFile(
        `[TaskServer] No tasks found for feature ID: ${feature_id}`
      )
      const errorMsg = `No tasks found for feature ID: ${feature_id}. The feature may not exist or has not been planned yet.`

      // Record error response in history
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'get_next_task',
        isError: true,
        message: errorMsg,
      })

      return {
        content: [{ type: 'text', text: errorMsg }],
        isError: true,
      }
    }

    // Find the first pending task in the list
    const nextTask = tasks.find((task) => task.status === 'pending')

    if (!nextTask) {
      await logToFile(
        `[TaskServer] No pending tasks found for feature ID: ${feature_id}`
      )
      const message = `No pending tasks found for feature ID: ${feature_id}. All tasks have been completed.`

      // Record completion response in history
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'get_next_task',
        isError: false,
        message,
      })

      return {
        content: [{ type: 'text', text: message }],
      }
    }

    // Found the next task based on sequential order
    await logToFile(`[TaskServer] Found next sequential task: ${nextTask.id}`)

    // Include effort in the message if available
    const effortInfo = nextTask.effort ? ` (Effort: ${nextTask.effort})` : ''

    // Include parent info if this is a subtask
    let parentInfo = ''
    if (nextTask.parentTaskId) {
      // Find the parent task (which should be marked completed)
      const parentTask = tasks.find((t) => t.id === nextTask!.parentTaskId)
      if (parentTask) {
        const parentDesc =
          parentTask.description.length > 30
            ? parentTask.description.substring(0, 30) + '...'
            : parentTask.description
        parentInfo = ` (Subtask of: "${parentDesc}")`
      } else {
        parentInfo = ` (Subtask of parent ID: ${nextTask.parentTaskId})` // Fallback if parent not found
      }
    }

    // Embed ID, description, effort, and parent info in the text message
    const message = `Next pending task (ID: ${nextTask.id})${effortInfo}${parentInfo}: ${nextTask.description}`

    // Record success response in history
    await addHistoryEntry(feature_id, 'tool_response', {
      tool: 'get_next_task',
      isError: false,
      message,
      task: nextTask,
    })

    return {
      content: [{ type: 'text', text: message }],
    }
  } catch (error) {
    const errorMsg = `Error processing get_next_task request: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(`[TaskServer] ${errorMsg}`)

    // Record error in history
    try {
      await addHistoryEntry(feature_id, 'tool_response', {
        tool: 'get_next_task',
        isError: true,
        message: errorMsg,
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
