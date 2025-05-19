import { parseAndValidateJsonResponse } from '../src/lib/llmUtils'
import { z } from 'zod'

jest.mock('../src/lib/logger', () => ({
  logToFile: jest.fn(),
}))

describe('Enhanced JSON Parser Tests', () => {
  const TestSchema = z.object({
    subtasks: z.array(
      z.object({
        description: z.string(),
        effort: z.enum(['low', 'medium', 'high']),
      })
    ),
  })

  test('should handle truncated JSON', () => {
    const truncatedJson = `{
      "subtasks": [
        {
          "description": "Step one: Prepare the environment.",
          "effort": "medium"
        },
        {
          "description": "Step two: Execute the main process.",
          "effort": "medium"
        },
        {
          "description": "Step three: Finalize and clean up.",
          "effort": "medium"
        }
      ]
    }`

    const result = parseAndValidateJsonResponse(truncatedJson, TestSchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subtasks.length).toBeGreaterThanOrEqual(2)
      expect(result.data.subtasks[0].description).toContain('Step one')
      expect(result.data.subtasks[0].effort).toBe('medium')
    }
  })

  test('should handle recoverable malformed JSON', () => {
    const malformedJson = `{
      "subtasks": [
        {
          "description": "Perform initial setup"
          "effort": "medium"
        },
        {
          "description": "Run validation checks",
          "effort": "low"
        }
      ]
    }`

    const result = parseAndValidateJsonResponse(malformedJson, TestSchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subtasks.length).toBeGreaterThanOrEqual(1)
      expect(result.data.subtasks[0].description).toContain('setup')
      expect(['low', 'medium', 'high']).toContain(
        result.data.subtasks[0].effort
      )
    }
  })

  test('should handle missing closing braces in JSON', () => {
    const missingBracesJson = `{
      "subtasks": [
        {
          "description": "Initialize the system",
          "effort": "medium"
        },
        {
          "description": "Complete the configuration",
          "effort": "low"
        }
      `

    const result = parseAndValidateJsonResponse(missingBracesJson, TestSchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subtasks.length).toBe(2)
      expect(result.data.subtasks[0].description).toBe('Initialize the system')
      expect(result.data.subtasks[1].description).toBe(
        'Complete the configuration'
      )
    }
  })
})
