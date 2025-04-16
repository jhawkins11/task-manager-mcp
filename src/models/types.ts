import { z } from 'zod'

// --- Zod Schemas ---
export const TaskSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'completed']),
  description: z.string(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  parentTaskId: z.string().uuid().optional(),
})

export const TaskListSchema = z.array(TaskSchema)
export type Task = z.infer<typeof TaskSchema>

// History entry schema
export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  role: z.enum(['user', 'model', 'tool_call', 'tool_response']),
  content: z.any(),
  featureId: z.string().uuid(),
})

export const FeatureHistorySchema = z.array(HistoryEntrySchema)
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

/**
 * Interface for a parent-child task relationship
 */
export interface TaskRelationship {
  parentId: string
  parentDescription: string
  childIds: string[]
}

/**
 * Options for task breakdown
 */
export interface BreakdownOptions {
  minSubtasks?: number
  maxSubtasks?: number
  preferredEffort?: 'low' | 'medium'
}

// --- WebSocket Message Types ---

export type WebSocketMessageType =
  | 'tasks_updated'
  | 'status_changed'
  | 'show_question'
  | 'question_response'
  | 'request_screenshot'
  | 'request_screenshot_ack'
  | 'error'
  | 'connection_established'
  | 'client_registration'

export interface WebSocketMessage {
  type: WebSocketMessageType
  featureId?: string
  payload?: any
}

export interface TasksUpdatedPayload {
  tasks: Task[]
  updatedAt: string
}

export interface StatusChangedPayload {
  taskId: string
  status: 'pending' | 'completed'
  updatedAt: string
}

export interface ShowQuestionPayload {
  questionId: string
  question: string
  options?: string[]
}

export interface QuestionResponsePayload {
  questionId: string
  response: string
}

export interface RequestScreenshotPayload {
  requestId: string
  target?: string
}

export interface RequestScreenshotAckPayload {
  requestId: string
  status: 'success' | 'error'
  imagePath?: string
  error?: string
}

export interface ClientRegistrationPayload {
  featureId: string
  clientId?: string
}

export interface ErrorPayload {
  code: string
  message: string
}
