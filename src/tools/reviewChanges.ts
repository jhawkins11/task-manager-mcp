import { logToFile } from '../lib/logger'
import { aiService } from '../services/aiService'
import { promisify } from 'util'
import { exec } from 'child_process'
import crypto from 'crypto'
import { CodeReviewSchema } from '../models/types'
import { z } from 'zod'

// Promisify child_process.exec for easier async/await usage
const execPromise = promisify(exec)

/**
 * Schema for structured code review output
 */
const CodeReviewResponseSchema = CodeReviewSchema

interface ReviewChangesParams {
  // No parameters required for review_changes tool
}

interface ReviewChangesResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Handles the review_changes tool request
 */
export async function handleReviewChanges(
  params: ReviewChangesParams = {}
): Promise<ReviewChangesResult> {
  await logToFile('[TaskServer] Handling review_changes request...')

  // Generate a review ID to track this specific review session
  const reviewId = crypto.randomUUID()

  try {
    // Can't record history for a specific feature as we don't have featureId here
    console.error(`[TaskServer] Recording review request with ID: ${reviewId}`)

    let message: string
    let isError = false

    const reviewModel = aiService.getReviewModel()

    if (!reviewModel) {
      await logToFile(
        '[TaskServer] Review model not initialized (check API key).'
      )
      message = 'Error: Review model not initialized. Check API Key.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    let gitDiff = ''
    try {
      await logToFile('[TaskServer] Running git diff HEAD...')
      const { stdout, stderr } = await execPromise('git --no-pager diff HEAD')
      if (stderr) {
        await logToFile(`[TaskServer] git diff stderr: ${stderr}`)
      }
      gitDiff = stdout
      if (!gitDiff.trim()) {
        await logToFile('[TaskServer] No staged changes found.')
        message = 'No staged changes found to review.'
        return { content: [{ type: 'text', text: message }] }
      }
      await logToFile(
        `[TaskServer] git diff captured (${gitDiff.length} chars).`
      )
    } catch (error: any) {
      if (error.message && error.message.includes('not a git repository')) {
        await logToFile('[TaskServer] Error: Not a git repository.')
        message = 'Error: The current directory is not a git repository.'
      } else {
        await logToFile(`[TaskServer] Error running git diff: ${error}`)
        message = 'Error running git diff to get changes.'
      }
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    try {
      await logToFile('[TaskServer] Calling LLM for review analysis...')

      // Structured prompt for code review
      const structuredPrompt = `Review the following code changes (git diff) and provide structured feedback:

\`\`\`diff
${gitDiff}
\`\`\`

Your review should include:
1. A brief summary of the changes
2. A list of issues found, with type, severity, description, and suggested fixes
3. General recommendations for improving the code

Respond with a structured JSON object containing this information.`

      let result
      let structuredReview: string | null = null

      // Use the appropriate model for review (through aiService)
      if ('chat' in reviewModel) {
        // Try structured output with OpenRouter
        const structuredResult = await aiService.callOpenRouterWithSchema(
          'google/gemini-2.5-pro-exp-03-25:free',
          [{ role: 'user', content: structuredPrompt }],
          CodeReviewResponseSchema,
          { temperature: 0.5 }
        )

        if (structuredResult.success) {
          // Format the structured review as readable text
          const review = structuredResult.data

          structuredReview = `# Code Review Summary
${review.summary}

## Issues Found
${review.issues
  .map(
    (issue) => `
### ${issue.type.toUpperCase()} (${issue.severity})
${issue.description}
${issue.location ? `**Location**: ${issue.location}` : ''}
${issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''}
`
  )
  .join('\n')}

## Recommendations
${review.recommendations.map((rec) => `- ${rec}`).join('\n')}
`

          result = structuredResult.rawResponse
          message = structuredReview
          await logToFile(
            '[TaskServer] Successfully generated structured code review.'
          )
        } else {
          // Fallback to unstructured review
          console.warn(
            `[TaskServer] Structured code review failed: ${structuredResult.error}. Falling back to unstructured format.`
          )

          // Use traditional prompt
          const fallbackPrompt = `Review the following code changes (git diff):\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\nProvide concise feedback on correctness, potential issues, style violations, and areas for refactoring. Structure your feedback clearly.`

          result = await reviewModel.chat.completions.create({
            model: 'google/gemini-2.5-pro-exp-03-25:free',
            messages: [{ role: 'user', content: fallbackPrompt }],
            temperature: 0.5,
          })

          message =
            aiService.extractTextFromResponse(result) ||
            'Error: Failed to get review response.'
        }
      } else {
        // Try structured output with Gemini
        const structuredResult = await aiService.callGeminiWithSchema(
          'gemini-2.5-pro-exp-03-25',
          structuredPrompt,
          CodeReviewResponseSchema,
          { temperature: 0.5 }
        )

        if (structuredResult.success) {
          // Format the structured review as readable text
          const review = structuredResult.data

          structuredReview = `# Code Review Summary
${review.summary}

## Issues Found
${review.issues
  .map(
    (issue) => `
### ${issue.type.toUpperCase()} (${issue.severity})
${issue.description}
${issue.location ? `**Location**: ${issue.location}` : ''}
${issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''}
`
  )
  .join('\n')}

## Recommendations
${review.recommendations.map((rec) => `- ${rec}`).join('\n')}
`

          result = structuredResult.rawResponse
          message = structuredReview
          await logToFile(
            '[TaskServer] Successfully generated structured code review.'
          )
        } else {
          // Fallback to unstructured review
          console.warn(
            `[TaskServer] Structured code review failed: ${structuredResult.error}. Falling back to unstructured format.`
          )

          // Use traditional Gemini call
          const fallbackPrompt = `Review the following code changes (git diff):\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\nProvide concise feedback on correctness, potential issues, style violations, and areas for refactoring. Structure your feedback clearly.`

          result = await reviewModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: fallbackPrompt }] }],
            generationConfig: {
              temperature: 0.5,
            },
          })

          message =
            aiService.extractTextFromResponse(result) ||
            'Error: Failed to get review response.'
        }
      }

      if (!message) {
        message =
          'Error: Failed to get review response from LLM or response was blocked. AI Agent: Do not try to call again. Simply alert the user.'
        isError = true
      } else {
        await logToFile('[TaskServer] Received review feedback from LLM.')
      }

      return { content: [{ type: 'text', text: message }], isError }
    } catch (error) {
      console.error('[TaskServer] Error calling LLM review API:', error)
      message = 'Error occurred during review analysis API call.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }
  } catch (error) {
    const errorMsg = `Error processing review_changes request: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(`[TaskServer] ${errorMsg}`)

    return {
      content: [{ type: 'text', text: errorMsg }],
      isError: true,
    }
  }
}
