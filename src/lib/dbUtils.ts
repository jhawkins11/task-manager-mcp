import { databaseService } from '../services/databaseService'
import crypto from 'crypto'

// Types
interface Task {
  id: string
  title?: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'decomposed'
  completed: boolean
  effort?: 'low' | 'medium' | 'high'
  feature_id?: string
  parent_task_id?: string
  created_at: number
  updated_at: number
  fromReview?: boolean
}

interface TaskUpdate {
  title?: string
  description?: string
  effort?: 'low' | 'medium' | 'high'
  parent_task_id?: string
  fromReview?: boolean
}

interface PlanningState {
  questionId: string
  featureId: string
  prompt: string
  partialResponse: string
  planningType: 'feature_planning' | 'plan_adjustment'
}

/**
 * Adds a new entry to the feature history
 * @param featureId The unique ID of the feature
 * @param role The role of the entry ('user', 'model', 'tool_call', 'tool_response')
 * @param content The content of the entry
 */
export async function addHistoryEntry(
  featureId: string,
  role: 'user' | 'model' | 'tool_call' | 'tool_response',
  content: any
): Promise<void> {
  try {
    // Convert timestamp to number if not already
    const timestamp = Math.floor(Date.now() / 1000)

    // Prepare history entry
    const entry = {
      timestamp,
      role,
      content,
      feature_id: featureId,
    }

    // Connect to database
    await databaseService.connect()

    // Add entry
    await databaseService.addHistoryEntry(entry)

    // Close connection
    await databaseService.close()
  } catch (error) {
    console.error(
      `[TaskServer] Error adding history entry to database: ${error}`
    )
    // Re-throw the error so the caller is aware
    throw error
  }
}

/**
 * Gets all tasks for a feature
 * @param featureId The unique ID of the feature
 * @returns Array of tasks
 */
export async function getAllTasksForFeature(
  featureId: string
): Promise<Task[]> {
  try {
    await databaseService.connect()
    const tasks = await databaseService.getTasksByFeatureId(featureId)
    await databaseService.close()
    return tasks
  } catch (error) {
    console.error(
      `[TaskServer] Error getting tasks for feature ${featureId}: ${error}`
    )
    throw error
  }
}

/**
 * Gets a task by ID
 * @param taskId The unique ID of the task
 * @returns The task or null if not found
 */
export async function getTaskById(taskId: string): Promise<Task | null> {
  try {
    await databaseService.connect()
    const task = await databaseService.getTaskById(taskId)
    await databaseService.close()
    return task
  } catch (error) {
    console.error(`[TaskServer] Error getting task ${taskId}: ${error}`)
    throw error
  }
}

/**
 * Creates a new task
 * @param featureId The feature ID the task belongs to
 * @param description The task description
 * @param options Optional task properties (title, effort, parentTaskId)
 * @returns The created task
 */
export async function createTask(
  featureId: string,
  description: string,
  options: {
    title?: string
    effort?: 'low' | 'medium' | 'high'
    parentTaskId?: string
    fromReview?: boolean
  } = {}
): Promise<Task> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const newTask: Task = {
      id: crypto.randomUUID(),
      description,
      title: options.title || description,
      status: 'pending',
      completed: false,
      effort: options.effort,
      feature_id: featureId,
      parent_task_id: options.parentTaskId,
      created_at: now,
      updated_at: now,
      fromReview: options.fromReview,
    }

    await databaseService.connect()
    await databaseService.addTask(newTask)
    await databaseService.close()

    return newTask
  } catch (error) {
    console.error(
      `[TaskServer] Error creating task for feature ${featureId}: ${error}`
    )
    throw error
  }
}

/**
 * Updates a task's status
 * @param taskId The unique ID of the task
 * @param status The new status
 * @param completed Optional completed flag
 * @returns True if successful, false otherwise
 */
export async function updateTaskStatus(
  taskId: string,
  status: 'pending' | 'in_progress' | 'completed' | 'decomposed',
  completed?: boolean
): Promise<boolean> {
  try {
    await databaseService.connect()
    const result = await databaseService.updateTaskStatus(
      taskId,
      status,
      completed
    )
    await databaseService.close()
    return result
  } catch (error) {
    console.error(
      `[TaskServer] Error updating task status for ${taskId}: ${error}`
    )
    throw error
  }
}

/**
 * Updates a task's details
 * @param taskId The unique ID of the task
 * @param updates The properties to update
 * @returns True if successful, false otherwise
 */
export async function updateTaskDetails(
  taskId: string,
  updates: TaskUpdate
): Promise<boolean> {
  try {
    await databaseService.connect()
    const result = await databaseService.updateTaskDetails(taskId, updates)
    await databaseService.close()
    return result
  } catch (error) {
    console.error(
      `[TaskServer] Error updating task details for ${taskId}: ${error}`
    )
    throw error
  }
}

/**
 * Deletes a task
 * @param taskId The unique ID of the task
 * @returns True if successful, false otherwise
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  try {
    await databaseService.connect()
    const result = await databaseService.deleteTask(taskId)
    await databaseService.close()
    return result
  } catch (error) {
    console.error(`[TaskServer] Error deleting task ${taskId}: ${error}`)
    throw error
  }
}

/**
 * Gets history entries for a feature
 * @param featureId The unique ID of the feature
 * @param limit Maximum number of entries to retrieve
 * @returns Array of history entries
 */
export async function getHistoryForFeature(
  featureId: string,
  limit: number = 100
): Promise<any[]> {
  try {
    await databaseService.connect()
    const history = await databaseService.getHistoryByFeatureId(
      featureId,
      limit
    )
    await databaseService.close()
    return history
  } catch (error) {
    console.error(
      `[TaskServer] Error getting history for feature ${featureId}: ${error}`
    )
    throw error
  }
}

/**
 * Stores intermediate planning state
 * @param featureId The feature ID being planned
 * @param prompt The original prompt
 * @param partialResponse The LLM's partial response
 * @param planningType The type of planning operation
 * @returns The generated question ID
 */
export async function addPlanningState(
  featureId: string,
  prompt: string,
  partialResponse: string,
  planningType: 'feature_planning' | 'plan_adjustment'
): Promise<string> {
  try {
    const questionId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    await databaseService.connect()

    await databaseService.runAsync(
      `INSERT INTO planning_states (
        question_id, feature_id, prompt, partial_response, planning_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [questionId, featureId, prompt, partialResponse, planningType, now]
    )

    await databaseService.close()

    return questionId
  } catch (error) {
    console.error(`[TaskServer] Error storing planning state: ${error}`)
    // Generate a questionId even in error case to avoid breaking the flow
    return crypto.randomUUID()
  }
}

/**
 * Gets planning state by question ID
 * @param questionId The question ID
 * @returns The planning state or null if not found
 */
export async function getPlanningStateByQuestionId(
  questionId: string
): Promise<PlanningState | null> {
  try {
    if (!questionId) {
      return null
    }

    await databaseService.connect()

    const row = await databaseService.get(
      `SELECT question_id, feature_id, prompt, partial_response, planning_type
       FROM planning_states
       WHERE question_id = ?`,
      [questionId]
    )

    await databaseService.close()

    if (!row) {
      return null
    }

    return {
      questionId: row.question_id,
      featureId: row.feature_id,
      prompt: row.prompt,
      partialResponse: row.partial_response,
      planningType: row.planning_type,
    }
  } catch (error) {
    console.error(
      `[TaskServer] Error getting planning state for question ${questionId}: ${error}`
    )
    // Re-throw error to distinguish DB errors from 'not found'
    throw error
  }
}

/**
 * Gets planning state by feature ID
 * @param featureId The feature ID
 * @returns The most recent planning state for the feature or null if not found
 */
export async function getPlanningStateByFeatureId(
  featureId: string
): Promise<PlanningState | null> {
  try {
    if (!featureId) {
      return null
    }

    await databaseService.connect()

    const row = await databaseService.get(
      `SELECT question_id, feature_id, prompt, partial_response, planning_type
       FROM planning_states
       WHERE feature_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [featureId]
    )

    await databaseService.close()

    if (!row) {
      return null
    }

    return {
      questionId: row.question_id,
      featureId: row.feature_id,
      prompt: row.prompt,
      partialResponse: row.partial_response,
      planningType: row.planning_type,
    }
  } catch (error) {
    console.error(
      `[TaskServer] Error getting planning state for feature ${featureId}: ${error}`
    )
    // Re-throw error to distinguish DB errors from 'not found'
    throw error
  }
}

/**
 * Clears planning state
 * @param questionId The question ID
 * @returns True if successful, false otherwise
 */
export async function clearPlanningState(questionId: string): Promise<boolean> {
  try {
    if (!questionId) {
      return false
    }

    await databaseService.connect()

    const result = await databaseService.runAsync(
      `DELETE FROM planning_states WHERE question_id = ?`,
      [questionId]
    )

    await databaseService.close()

    return result.changes > 0
  } catch (error) {
    console.error(
      `[TaskServer] Error clearing planning state for question ${questionId}: ${error}`
    )
    return false
  }
}

/**
 * Clears all planning states for a feature
 * @param featureId The feature ID
 * @returns Number of states cleared
 */
export async function clearPlanningStatesForFeature(
  featureId: string
): Promise<number> {
  try {
    if (!featureId) {
      return 0
    }

    await databaseService.connect()

    const result = await databaseService.runAsync(
      `DELETE FROM planning_states WHERE feature_id = ?`,
      [featureId]
    )

    await databaseService.close()

    return result.changes || 0
  } catch (error) {
    console.error(
      `[TaskServer] Error clearing planning states for feature ${featureId}: ${error}`
    )
    return 0
  }
}
