import { z } from 'zod'

// --- Zod Schemas ---
export const TaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().optional(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  completed: z.boolean().default(false),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  feature_id: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
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

// --- Structured Output Schemas ---

// Schema for a single task in planning response
export const PlanningTaskSchema = z.object({
  description: z.string().describe('Description of the task to be done'),
  effort: z
    .enum(['low', 'medium', 'high'])
    .describe('Estimated effort level for this task'),
})

// Full planning response schema
export const PlanningOutputSchema = z.object({
  tasks: z
    .array(PlanningTaskSchema)
    .describe('List of tasks for implementation'),
})

export type PlanningOutput = z.infer<typeof PlanningOutputSchema>

// Schema for effort estimation response
export const EffortEstimationSchema = z.object({
  effort: z
    .enum(['low', 'medium', 'high'])
    .describe('Estimated effort required for the task'),
  reasoning: z
    .string()
    .describe('Reasoning behind the effort estimation')
    .optional(),
})

export type EffortEstimation = z.infer<typeof EffortEstimationSchema>

// Schema for task breakdown response
export const TaskBreakdownSchema = z.object({
  parentTaskId: z.string().uuid().describe('ID of the high-effort parent task'),
  subtasks: z
    .array(
      z.object({
        description: z.string().describe('Description of the subtask'),
        effort: z
          .enum(['low', 'medium'])
          .describe('Effort level for this subtask'),
      })
    )
    .describe('List of smaller subtasks that make up the original task'),
})

export type TaskBreakdown = z.infer<typeof TaskBreakdownSchema>

// Schema for code review response
export const CodeReviewSchema = z.object({
  summary: z.string().describe('Brief summary of the code changes reviewed'),
  issues: z
    .array(
      z.object({
        type: z
          .enum(['bug', 'style', 'performance', 'security', 'suggestion'])
          .describe('Type of issue found'),
        severity: z
          .enum(['low', 'medium', 'high'])
          .describe('Severity of the issue'),
        description: z.string().describe('Description of the issue'),
        location: z
          .string()
          .describe('File and line number where the issue was found')
          .optional(),
        suggestion: z
          .string()
          .describe('Suggested fix for the issue')
          .optional(),
      })
    )
    .describe('List of issues found in the code review'),
  recommendations: z
    .array(z.string())
    .describe('Overall recommendations for improving the code'),
})

export type CodeReview = z.infer<typeof CodeReviewSchema>

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
  status: 'pending' | 'in_progress' | 'completed'
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

// Schema for task breakdown response used in llmUtils.ts
export const TaskBreakdownResponseSchema = z.object({
  subtasks: z
    .array(
      z.object({
        description: z.string().describe('Description of the subtask'),
        effort: z
          .enum(['low', 'medium'])
          .describe('Estimated effort level for the subtask'),
      })
    )
    .describe('List of smaller subtasks that make up the original task'),
})

export type TaskBreakdownResponse = z.infer<typeof TaskBreakdownResponseSchema>

// Schema for feature planning response used in planFeature.ts
export const PlanFeatureResponseSchema = z.object({
  tasks: z
    .array(
      z.object({
        description: z
          .string()
          .describe('Detailed description of the coding task'),
        effort: z
          .enum(['low', 'medium', 'high'])
          .describe('Estimated effort required for this task'),
      })
    )
    .describe('List of ordered, sequential tasks for implementing the feature'),
})

export type PlanFeatureResponse = z.infer<typeof PlanFeatureResponseSchema>
