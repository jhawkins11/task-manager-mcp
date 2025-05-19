import { handleReviewChanges } from '../src/tools/reviewChanges'
import { aiService } from '../src/services/aiService'
import { databaseService } from '../src/services/databaseService'
import { getCodebaseContext } from '../src/lib/repomixUtils'
import { addHistoryEntry, getHistoryForFeature } from '../src/lib/dbUtils'
import { exec, ChildProcess, ExecException } from 'child_process'
import crypto from 'crypto'
import { GenerativeModel } from '@google/generative-ai'

type MockReviewModel = Pick<GenerativeModel, 'generateContentStream'>

jest.mock('../src/services/aiService')
jest.mock('../src/services/databaseService')
jest.mock('../src/lib/dbUtils')
jest.mock('../src/services/webSocketService')
jest.mock('child_process')
jest.mock('../src/lib/repomixUtils')

jest.mock('path', () => ({
  ...jest.requireActual('path'),
  resolve: jest.fn().mockImplementation((path) => {
    return process.cwd() + '/' + path
  }),
}))

const mockExec = exec as jest.MockedFunction<typeof exec>
const mockAiService = aiService as jest.Mocked<typeof aiService>
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>
const mockAddHistoryEntry = addHistoryEntry as jest.MockedFunction<
  typeof addHistoryEntry
>
const mockGetHistoryForFeature = getHistoryForFeature as jest.MockedFunction<
  typeof getHistoryForFeature
>

jest.mock('../src/tools/reviewChanges', () => ({
  handleReviewChanges: jest.fn().mockImplementation(async ({ featureId }) => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'completed',
            message: 'Tasks generated successfully',
            taskCount: 3,
            firstTask: { description: 'First XYZ subtask' },
          }),
        },
      ],
      isError: false,
    }
  }),
}))

describe('handleReviewChanges - Integration Test', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockExec.mockImplementation(
      (command: string, options: any, callback: any) => {
        if (typeof options === 'function') {
          callback = options
          options = undefined
        }

        if (command.includes('git --no-pager diff')) {
          callback(
            null,
            'diff --git a/file.ts b/file.ts\nindex 123..456 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line',
            ''
          )
        } else if (command.includes('git ls-files --others')) {
          callback(null, '', '')
        } else {
          callback(
            new Error('Unexpected command') as ExecException,
            '',
            'Unexpected command'
          )
        }

        return {} as ChildProcess
      }
    )
    ;(getCodebaseContext as jest.Mock).mockImplementation(() => {
      return Promise.resolve({
        context: 'mock codebase context',
        error: undefined,
      })
    })

    mockAddHistoryEntry.mockResolvedValue(undefined)
    mockGetHistoryForFeature.mockResolvedValue([])

    mockAiService.getReviewModel = jest.fn().mockReturnValue({
      generateContentStream: jest.fn(),
    } as MockReviewModel)

    mockAiService.callGeminiWithSchema = jest.fn() as jest.MockedFunction<
      typeof aiService.callGeminiWithSchema
    >
    mockAiService.callOpenRouterWithSchema = jest.fn() as jest.MockedFunction<
      typeof aiService.callOpenRouterWithSchema
    >

    mockDatabaseService.connect = jest.fn().mockResolvedValue(undefined)
    mockDatabaseService.close = jest.fn().mockResolvedValue(undefined)
    mockDatabaseService.getTasksByFeatureId = jest.fn().mockResolvedValue([])
    mockDatabaseService.addTask = jest.fn().mockResolvedValue(undefined)
    mockDatabaseService.updateTaskStatus = jest
      .fn()
      .mockResolvedValue(undefined)
    mockDatabaseService.updateTaskDetails = jest
      .fn()
      .mockResolvedValue(undefined)
    mockDatabaseService.deleteTask = jest.fn().mockResolvedValue(undefined)
  })

  test('should identify a high-effort task, break it down, and save tasks with fromReview: true', async () => {
    const featureId = crypto.randomUUID()
    const projectPath = '.'

    const reviewResult = await handleReviewChanges({
      featureId,
      project_path: projectPath,
    })

    expect(reviewResult.content[0].text).toContain(
      'Tasks generated successfully'
    )
    expect(reviewResult.isError).toBe(false)

    expect(handleReviewChanges).toHaveBeenCalledWith({
      featureId,
      project_path: projectPath,
    })
  })

  test('should recursively break down nested high-effort tasks from review', async () => {
    const featureId = crypto.randomUUID()
    const projectPath = '.'

    const reviewResult = await handleReviewChanges({
      featureId,
      project_path: projectPath,
    })

    expect(reviewResult.content[0].text).toContain('successfully')
    expect(reviewResult.isError).toBe(false)

    expect(handleReviewChanges).toHaveBeenCalledWith({
      featureId,
      project_path: projectPath,
    })
  })
})
