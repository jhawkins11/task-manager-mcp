import { logToFile } from '../lib/logger'
import { aiService } from '../services/aiService'
import { promisify } from 'util'
import { exec } from 'child_process'
import crypto from 'crypto'
import { CodeReviewSchema, CodeReview } from '../models/types'
import { z } from 'zod'
import {
  parseAndValidateJsonResponse,
  processAndFinalizePlan,
} from '../lib/llmUtils'
import {
  GIT_DIFF_MAX_BUFFER_MB,
  GEMINI_MODEL,
  OPENROUTER_MODEL,
} from '../config'
const { ReviewResponseWithTasksSchema } = require('../models/types')
import path from 'path'
import fs from 'fs/promises'
import { getCodebaseContext } from '../lib/repomixUtils'

// Promisify child_process.exec for easier async/await usage
const execPromise = promisify(exec)

/**
 * Schema for structured code review output
 */
const CodeReviewResponseSchema = CodeReviewSchema

interface ReviewChangesParams {
  featureId: string // Required feature ID (UUID)
  project_path?: string // Add optional project_path
}

interface ReviewChangesResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Handles the review_changes tool request
 */
export async function handleReviewChanges(
  params: ReviewChangesParams // Update parameter type
): Promise<ReviewChangesResult> {
  await logToFile('[TaskServer] Handling review_changes request...')

  const { featureId, project_path } = params // Destructure featureId and project_path

  // --- Path Validation ---
  let targetDir = '.' // Default to current directory
  if (project_path) {
    // Basic check for path traversal characters
    if (project_path.includes('..') || project_path.includes('~')) {
      const errorMsg = `Error: Invalid project_path provided: ${project_path}. Path cannot contain '..' or '~'.`
      await logToFile(`[TaskServer] ${errorMsg}`)
      return { content: [{ type: 'text', text: errorMsg }], isError: true }
    }

    // Resolve the path and check it's within a reasonable base (e.g., current working directory)
    const resolvedPath = path.resolve(project_path)
    const cwd = process.cwd()

    // This is a basic check; more robust checks might compare against a known workspace root
    if (!resolvedPath.startsWith(cwd)) {
      const errorMsg = `Error: Invalid project_path provided: ${project_path}. Path must be within the current workspace.`
      await logToFile(`[TaskServer] ${errorMsg}`)
      return { content: [{ type: 'text', text: errorMsg }], isError: true }
    }
    targetDir = resolvedPath // Use the validated, absolute path
  } else {
    targetDir = process.cwd() // Use absolute path for default case too
  }

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
        '[TaskServer] Review model not initialized (check API key).',
        'error'
      )
      message = 'Error: Review model not initialized. Check API Key.'
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    // --- Get Codebase Context using Utility Function ---
    const { context: codebaseContext, error: contextError } =
      await getCodebaseContext(
        targetDir,
        reviewId // Use reviewId as log context
      )

    // Handle potential errors from getCodebaseContext
    if (contextError) {
      message = contextError // Use the user-friendly error from the utility
      isError = true
      // Note: Consider adding history entry here if needed
      return { content: [{ type: 'text', text: message }], isError }
    }

    // --- Git Diff Execution --- (Existing logic)
    let gitDiff = ''
    try {
      await logToFile(
        `[TaskServer] Running git diff HEAD in directory: ${targetDir}... (reviewId: ${reviewId})`
      )
      // Execute git commands directly in the validated target directory
      const diffCmd = `git --no-pager diff HEAD`
      const lsFilesCmd = `git ls-files --others --exclude-standard`
      const execOptions = {
        cwd: targetDir, // Set current working directory for the command
        maxBuffer: GIT_DIFF_MAX_BUFFER_MB * 1024 * 1024,
      }

      const { stdout: diffStdout, stderr: diffStderr } = await execPromise(
        diffCmd,
        execOptions
      )
      if (diffStderr) {
        await logToFile(
          `[TaskServer] git diff stderr: ${diffStderr} (reviewId: ${reviewId})`
        )
      }
      let combinedDiff = diffStdout

      const { stdout: untrackedStdout } = await execPromise(
        lsFilesCmd,
        execOptions
      )
      const untrackedFiles = untrackedStdout
        .split('\n')
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0)
      for (const file of untrackedFiles) {
        // Ensure the filename itself is not malicious (basic check)
        if (file.includes('..') || file.includes('/') || file.includes('\\')) {
          await logToFile(
            `[TaskServer] Skipping potentially unsafe untracked filename: ${file} (reviewId: ${reviewId})`
          )
          continue
        }
        // For each untracked file, get its diff
        const fileDiffCmd = `git --no-pager diff --no-index /dev/null "${file}"`
        try {
          const { stdout: fileDiff } = await execPromise(
            fileDiffCmd,
            execOptions
          )
          if (fileDiff && fileDiff.trim().length > 0) {
            combinedDiff += `\n\n${fileDiff}`
          }
        } catch (fileDiffErr) {
          await logToFile(
            `[TaskServer] Error getting diff for untracked file ${file}: ${fileDiffErr} (reviewId: ${reviewId})`
          )
        }
      }
      gitDiff = combinedDiff
      // Warn if diff size is within 90% of buffer limit
      const bufferLimit = GIT_DIFF_MAX_BUFFER_MB * 1024 * 1024
      if (gitDiff.length > 0.9 * bufferLimit) {
        await logToFile(
          `[TaskServer] WARNING: git diff output size (${gitDiff.length} bytes) is within 90% of the buffer limit (${bufferLimit} bytes). Consider increasing GIT_DIFF_MAX_BUFFER_MB if you expect larger diffs.`
        )
      }
      if (!gitDiff.trim()) {
        await logToFile(
          `[TaskServer] No staged or untracked changes found. (reviewId: ${reviewId})`
        )
        message = 'No staged or untracked changes found to review.'
        return { content: [{ type: 'text', text: message }] }
      }
      await logToFile(
        `[TaskServer] git diff (including untracked) captured (${gitDiff.length} chars). (reviewId: ${reviewId})`
      )
    } catch (error: any) {
      if (error.message && error.message.includes('not a git repository')) {
        await logToFile(
          `[TaskServer] Error: Not a git repository. (reviewId: ${reviewId})`
        )
        message = 'Error: The current directory is not a git repository.'
      } else {
        await logToFile(
          `[TaskServer] Error running git diff: ${error} (reviewId: ${reviewId})`
        )
        message = 'Error running git diff to get changes.'
      }
      isError = true
      return { content: [{ type: 'text', text: message }], isError }
    }

    // --- LLM Review Logic (DRY Refactor) ---
    async function getStructuredReview({
      reviewModel,
      structuredPrompt,
      fallbackPrompt,
      schema,
      reviewId,
    }: {
      reviewModel: any
      structuredPrompt: string
      fallbackPrompt: string
      schema: any
      reviewId: string
    }) {
      let message = ''
      let result
      let structuredReview: string | null = null
      let usedFallback = false
      if ('chat' in reviewModel) {
        const structuredResult = await aiService.callOpenRouterWithSchema(
          OPENROUTER_MODEL,
          [{ role: 'user', content: structuredPrompt }],
          schema,
          { temperature: 0.5 }
        )
        if (structuredResult.success) {
          const review = structuredResult.data as CodeReview
          structuredReview = `# Code Review Summary\n${
            review.summary
          }\n\n## Issues Found\n${review.issues
            .map(
              (issue) =>
                `\n### ${issue.type.toUpperCase()} (${issue.severity})\n${
                  issue.description
                }\n${
                  issue.location ? `**Location**: ${issue.location}` : ''
                }\n${
                  issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''
                }\n`
            )
            .join('\n')}\n\n## Recommendations\n${review.recommendations
            .map((rec) => `- ${rec}`)
            .join('\n')}\n`
          result = structuredResult.rawResponse
          message = structuredReview
          await logToFile(
            `[TaskServer] Successfully generated structured code review. (reviewId: ${reviewId})`
          )
        } else {
          usedFallback = true
        }
      } else {
        const structuredResult = await aiService.callGeminiWithSchema(
          GEMINI_MODEL,
          structuredPrompt,
          schema,
          { temperature: 0.5 }
        )
        if (structuredResult.success) {
          const review = structuredResult.data as CodeReview
          structuredReview = `# Code Review Summary\n${
            review.summary
          }\n\n## Issues Found\n${review.issues
            .map(
              (issue) =>
                `\n### ${issue.type.toUpperCase()} (${issue.severity})\n${
                  issue.description
                }\n${
                  issue.location ? `**Location**: ${issue.location}` : ''
                }\n${
                  issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''
                }\n`
            )
            .join('\n')}\n\n## Recommendations\n${review.recommendations
            .map((rec) => `- ${rec}`)
            .join('\n')}\n`
          result = structuredResult.rawResponse
          message = structuredReview
          await logToFile(
            `[TaskServer] Successfully generated structured code review. (reviewId: ${reviewId})`
          )
        } else {
          usedFallback = true
        }
      }
      if (usedFallback) {
        await logToFile(
          `[TaskServer] Structured code review failed. Falling back to unstructured format. (reviewId: ${reviewId})`
        )
        if ('chat' in reviewModel) {
          result = await reviewModel.chat.completions.create({
            model: OPENROUTER_MODEL,
            messages: [{ role: 'user', content: fallbackPrompt }],
            temperature: 0.5,
          })
          message =
            aiService.extractTextFromResponse(result) ||
            'Error: Failed to get review response.'
        } else {
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
      return message
    }

    try {
      await logToFile(
        `[TaskServer] Calling LLM for review analysis... (reviewId: ${reviewId})`,
        'info'
      )

      // Prepare context part for prompt
      const contextPromptPart = codebaseContext
        ? `\n\nAdditionally, consider this overview of the codebase structure:\n\`\`\`\n${codebaseContext}\n\`\`\`\n`
        : '\n\n(No overall codebase context was available for this review.)'

      // Update prompts to include codebase context
      const structuredPrompt = `You are a senior software engineer performing a code review. Review the following code changes (git diff):\n\n\u007f\u007f\u007f\ndiff\n${gitDiff}\n\u007f\u007f\u007f\n${contextPromptPart}\n\nBased on your review of the changes *and* the overall codebase context (if provided), generate a list of actionable coding tasks that a developer should perform to address any issues, improvements, or refactoring opportunities you find.\n\nFor each task, provide:\n- A clear, concise description of the coding action required.\n- An estimated effort level: 'low', 'medium', or 'high'.\n\nIf there are no actionable coding tasks required, respond with an empty tasks array.\n\nRespond ONLY with a single valid JSON object matching this exact schema:\n{\n  "tasks": [\n    { "description": "Task description here", "effort": "low" | "medium" | "high" },\n    ...\n  ]\n}\n\nDo NOT include any summary, issues, recommendations, or any text outside the JSON object. Do not use markdown formatting.`

      const fallbackPrompt = `Review the following code changes (git diff):\n\u007f\u007f\u007f\ndiff\n${gitDiff}\n\u007f\u007f\u007f\n${contextPromptPart}\n\nList the coding tasks needed to address any issues or improvements based on the changes and context. For each, provide a description and an effort rating (low, medium, high). Respond with a JSON object: { "tasks": [ { "description": "...", "effort": "low" }, ... ] }.`

      message = await getStructuredReview({
        reviewModel,
        structuredPrompt,
        fallbackPrompt,
        schema: ReviewResponseWithTasksSchema,
        reviewId,
      })
      if (!message) {
        message =
          'Error: Failed to get review response from LLM or response was blocked. AI Agent: Do not try to call again. Simply alert the user.'
        isError = true
        return { content: [{ type: 'text', text: message }], isError }
      }
      // Validate the response against the ReviewResponseWithTasksSchema
      const validation = parseAndValidateJsonResponse(
        message,
        ReviewResponseWithTasksSchema
      )
      if (!validation.success) {
        const snippet =
          message.length > 300 ? message.slice(0, 300) + '...' : message
        message = `Error: LLM response did not match expected schema. ${validation.error}\nResponse snippet: ${snippet}`
        isError = true
        return { content: [{ type: 'text', text: message }], isError }
      }
      // Extract raw task descriptions in the format expected by processAndFinalizePlan
      const rawPlanSteps = validation.data.tasks.map(
        (task: { description: string; effort: string }) =>
          `[${task.effort}] ${task.description}`
      )
      // Use the review model for effort estimation/breakdown
      const finalTasks = await processAndFinalizePlan(
        rawPlanSteps,
        reviewModel,
        featureId,
        true // fromReview
      )
      const taskCount = finalTasks.length
      let firstTaskDesc = finalTasks[0]?.description
      const responseData = {
        status: 'completed',
        message: `Successfully created ${taskCount} tasks from code review.${
          firstTaskDesc ? ' First task: "' + firstTaskDesc + '"' : ''
        } To start implementation, call 'get_next_task' with featureId '${featureId}'.`,
        featureId: featureId,
      }
      await logToFile(`[TaskServer] ${responseData.message}`)
      return {
        content: [{ type: 'text', text: JSON.stringify(responseData) }],
        isError: false,
      }
    } catch (error) {
      console.error(
        `[TaskServer] Error calling LLM review API (reviewId: ${reviewId}):`,
        error
      )
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
