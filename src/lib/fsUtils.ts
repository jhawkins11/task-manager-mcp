import path from 'path'
import fs from 'fs/promises'
import {
  Task,
  TaskListSchema,
  HistoryEntry,
  FeatureHistorySchema,
} from '../models/types'
import { logToFile } from './logger'
import { FEATURE_TASKS_DIR } from '../config'

/**
 * Gets the absolute path to a feature-specific task file
 * @param featureId The unique ID of the feature
 * @returns The absolute path to the feature's task file
 */
export function getFeatureTaskFilePath(featureId: string): string {
  return path.join(FEATURE_TASKS_DIR, `${featureId}_mcp_tasks.json`)
}

/**
 * Gets the absolute path to a feature-specific history file
 * @param featureId The unique ID of the feature
 * @returns The absolute path to the feature's history file
 */
export function getFeatureHistoryFilePath(featureId: string): string {
  return path.join(FEATURE_TASKS_DIR, `${featureId}_mcp_history.json`)
}

/**
 * Reads tasks for a specific feature from its task file
 * @param featureId The unique ID of the feature
 * @returns Array of tasks for the feature
 */
export async function readTasks(featureId: string): Promise<Task[]> {
  const taskFilePath = getFeatureTaskFilePath(featureId)
  try {
    await fs.access(taskFilePath)
    const data = await fs.readFile(taskFilePath, 'utf-8')
    if (!data.trim()) {
      await logToFile(
        `[TaskServer] Info: Task file at ${taskFilePath} is empty. Starting fresh.`
      )
      return []
    }
    const tasks = TaskListSchema.parse(JSON.parse(data))
    return tasks
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.error(
        `[TaskServer] Info: No task file found at ${taskFilePath}. Starting fresh.`
      )
    } else {
      console.error(
        `[TaskServer] Error reading tasks file at ${taskFilePath}:`,
        error
      )
    }
    return []
  }
}

/**
 * Writes tasks for a specific feature to its task file
 * @param featureId The unique ID of the feature
 * @param tasks Array of tasks to write
 */
export async function writeTasks(
  featureId: string,
  tasks: Task[]
): Promise<void> {
  const taskFilePath = getFeatureTaskFilePath(featureId)
  try {
    await fs.mkdir(path.dirname(taskFilePath), { recursive: true })
    const validatedTasks = TaskListSchema.parse(tasks)
    await fs.writeFile(taskFilePath, JSON.stringify(validatedTasks, null, 2))
    await logToFile(`[TaskServer] Info: Tasks saved to ${taskFilePath}`)
  } catch (error) {
    console.error('[TaskServer] Error writing tasks:', error)
  }
}

/**
 * Reads history entries for a specific feature from its history file
 * @param featureId The unique ID of the feature
 * @returns Array of history entries for the feature
 */
export async function readHistory(featureId: string): Promise<HistoryEntry[]> {
  const historyFilePath = getFeatureHistoryFilePath(featureId)
  try {
    await fs.access(historyFilePath)
    const data = await fs.readFile(historyFilePath, 'utf-8')
    if (!data.trim()) {
      await logToFile(
        `[TaskServer] Info: History file at ${historyFilePath} is empty. Starting fresh.`
      )
      return []
    }
    const history = FeatureHistorySchema.parse(JSON.parse(data))
    return history
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.error(
        `[TaskServer] Info: No history file found at ${historyFilePath}. Starting fresh.`
      )
    } else {
      console.error(
        `[TaskServer] Error reading history file at ${historyFilePath}:`,
        error
      )
    }
    return []
  }
}

/**
 * Writes history entries for a specific feature to its history file
 * @param featureId The unique ID of the feature
 * @param history Array of history entries to write
 */
export async function writeHistory(
  featureId: string,
  history: HistoryEntry[]
): Promise<void> {
  const historyFilePath = getFeatureHistoryFilePath(featureId)
  try {
    await fs.mkdir(path.dirname(historyFilePath), { recursive: true })
    const validatedHistory = FeatureHistorySchema.parse(history)
    await fs.writeFile(
      historyFilePath,
      JSON.stringify(validatedHistory, null, 2)
    )
    await logToFile(`[TaskServer] Info: History saved to ${historyFilePath}`)
  } catch (error) {
    console.error('[TaskServer] Error writing history:', error)
  }
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
    const history = await readHistory(featureId)
    const newEntry: HistoryEntry = {
      timestamp: new Date().toISOString(),
      role,
      content,
      featureId,
    }
    history.push(newEntry)
    await writeHistory(featureId, history)
  } catch (error) {
    console.error(`[TaskServer] Error adding history entry: ${error}`)
  }
}
