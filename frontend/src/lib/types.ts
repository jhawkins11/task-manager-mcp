/**
 * Task interface mirroring the backend structure
 */
export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  completed: boolean
  effort: 'low' | 'medium' | 'high'
  feature_id?: string
  parentTaskId?: string
  createdAt?: string
  updatedAt?: string
  children?: Task[]
  fromReview?: boolean
}

/**
 * Feature interface for grouping tasks
 */
export interface Feature {
  id: string
  title: string
  description: string
  tasks?: Task[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Task status enum for type safety
 */
export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  DECOMPOSED = 'decomposed',
}

/**
 * Task effort enum for type safety
 */
export enum TaskEffort {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

// --- Frontend Specific Types ---

// Mirror the backend WebSocket message structure
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
  | 'task_created'
  | 'task_updated'
  | 'task_deleted'

export interface WebSocketMessage {
  type: WebSocketMessageType
  featureId?: string
  payload?: any // Keep payload generic for now, specific handlers will parse
}

// Interface for clarification question payload
export interface ShowQuestionPayload {
  questionId: string
  question: string
  options?: string[]
  allowsText?: boolean
}

// Interface for user's response to a clarification question
export interface QuestionResponsePayload {
  questionId: string
  response: string
}

// Interface for task created event
export interface TaskCreatedPayload {
  task: Task
  featureId: string
  createdAt: string
}

// Interface for task updated event
export interface TaskUpdatedPayload {
  task: Task
  featureId: string
  updatedAt: string
}

// Interface for task deleted event
export interface TaskDeletedPayload {
  taskId: string
  featureId: string
  deletedAt: string
}
