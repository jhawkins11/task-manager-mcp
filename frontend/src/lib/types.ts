/**
 * Task interface mirroring the backend structure
 */
export interface Task {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  completed: boolean
  effort: 'low' | 'medium' | 'high'
  feature_id?: string
  parentTaskId?: string
  createdAt?: string
  updatedAt?: string
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
}

/**
 * Task effort enum for type safety
 */
export enum TaskEffort {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}
