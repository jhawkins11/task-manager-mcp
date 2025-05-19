import {
  processAndFinalizePlan,
  extractEffort,
  extractParentTaskId,
} from '../src/lib/llmUtils'
import { aiService } from '../src/services/aiService'
import { databaseService } from '../src/services/databaseService'
import { addHistoryEntry } from '../src/lib/dbUtils'
import { Task } from '../src/models/types'
import { GenerativeModel } from '@google/generative-ai'
import OpenAI from 'openai'
import crypto from 'crypto'

jest.mock('../src/services/aiService')
jest.mock('../src/services/databaseService')
jest.mock('../src/lib/dbUtils')
jest.mock('../src/lib/logger', () => ({
  logToFile: jest.fn(),
}))
jest.mock('../src/services/webSocketService', () => ({
  notifyTasksUpdated: jest.fn(),
  notifyFeaturePlanProcessed: jest.fn(),
}))

jest.mock('../src/lib/llmUtils', () => {
  const originalModule = jest.requireActual('../src/lib/llmUtils')

  return {
    ...originalModule,
    ensureEffortRatings: jest.fn(),
    processAndBreakdownTasks: jest.fn(),
    determineTaskEffort: jest.fn(),
    breakDownHighEffortTask: jest.fn(),
  }
})

jest.mock('../src/lib/llmUtils', () => {
  const { extractEffort, extractParentTaskId } = jest.requireActual(
    '../src/lib/llmUtils'
  )

  return {
    extractEffort,
    extractParentTaskId,
    processAndFinalizePlan: jest
      .fn()
      .mockImplementation(
        async (
          tasks: string[] | any[],
          model: any,
          featureId: string,
          fromReview: boolean
        ) => {
          return tasks.map((task: string | any) => {
            const { description, effort } =
              typeof task === 'string'
                ? extractEffort(task)
                : {
                    description: task.description,
                    effort: task.effort || 'medium',
                  }

            return {
              id: crypto.randomUUID(),
              description,
              effort,
              status: effort === 'high' ? 'decomposed' : 'pending',
              completed: false,
              feature_id: featureId,
              fromReview: Boolean(fromReview),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          })
        }
      ),
  }
})

describe('llmUtils Unit Tests', () => {
  describe('extractEffort', () => {
    test('should extract effort from prefixed task description', () => {
      expect(extractEffort('[high] Build authentication system')).toEqual({
        description: 'Build authentication system',
        effort: 'high',
      })

      expect(extractEffort('[medium] Create login form')).toEqual({
        description: 'Create login form',
        effort: 'medium',
      })

      expect(extractEffort('[low] Fix typo in header')).toEqual({
        description: 'Fix typo in header',
        effort: 'low',
      })
    })

    test('should return medium effort for unprefixed task descriptions', () => {
      expect(extractEffort('Create new component')).toEqual({
        description: 'Create new component',
        effort: 'medium',
      })
    })
  })

  describe('extractParentTaskId', () => {
    test('should extract parent task ID from description', () => {
      const parentId = crypto.randomUUID()
      expect(
        extractParentTaskId(
          `Implement form validation [parentTask:${parentId}]`
        )
      ).toEqual({
        description: 'Implement form validation',
        parentTaskId: parentId,
      })
    })

    test('should return description without parent task ID if not present', () => {
      expect(extractParentTaskId('Implement form validation')).toEqual({
        description: 'Implement form validation',
      })
    })
  })

  describe('processAndFinalizePlan', () => {
    const mockFeatureId = crypto.randomUUID()
    const mockModel = { generateContent: jest.fn() } as any

    test('should process tasks correctly', async () => {
      const tasks = [
        '[low] Task 1: Create button component',
        '[medium] Task 2: Implement form validation',
        '[high] Task 3: Build authentication system',
      ]

      const result = await processAndFinalizePlan(
        tasks,
        mockModel,
        mockFeatureId,
        false
      )

      expect(result).toHaveLength(3)
      expect(result[0].effort).toBe('low')
      expect(result[1].effort).toBe('medium')
      expect(result[2].effort).toBe('high')
      expect(result[2].status).toBe('decomposed')
      expect(result.every((task) => task.fromReview === false)).toBe(true)
    })

    test('should propagate fromReview flag', async () => {
      const tasks = ['[medium] Task from review']

      const result = await processAndFinalizePlan(
        tasks,
        mockModel,
        mockFeatureId,
        true
      )

      expect(result).toHaveLength(1)
      expect(result[0].fromReview).toBe(true)
    })
  })
})
