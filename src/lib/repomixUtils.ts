import path from 'path'
import fs from 'fs/promises'
import { promisify } from 'util'
import { exec } from 'child_process'
import { logToFile } from './logger'
// Potentially import encoding_for_model and config if including token counting/compression

const execPromise = promisify(exec)

/**
 * Executes repomix in the target directory and returns the codebase context.
 * Handles errors and ensures an empty string is returned if context cannot be gathered.
 *
 * @param targetDir The directory to run repomix in.
 * @param logContext An identifier (like featureId or reviewId) for logging.
 * @returns The codebase context string, or an empty string on failure or no context.
 * @throws Error if repomix command is not found.
 */
export async function getCodebaseContext(
  targetDir: string,
  logContext: string
): Promise<{ context: string; error?: string }> {
  let codebaseContext = ''
  let userFriendlyError: string | undefined

  try {
    const repomixOutputPath = path.join(targetDir, 'repomix-output.txt')
    // Ensure the output directory exists
    await fs.mkdir(path.dirname(repomixOutputPath), { recursive: true })

    const repomixCommand = `npx repomix ${targetDir} --style plain --output ${repomixOutputPath}`
    await logToFile(
      `[RepomixUtil/${logContext}] Running command: ${repomixCommand}`,
      'debug'
    )

    // Execute repomix in the target directory
    let { stdout: repomixStdout, stderr: repomixStderr } = await execPromise(
      repomixCommand,
      { cwd: targetDir, maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
    )

    if (repomixStderr) {
      await logToFile(
        `[RepomixUtil/${logContext}] repomix stderr: ${repomixStderr}`,
        'warn'
      )
      if (repomixStderr.includes('Permission denied')) {
        userFriendlyError = `Error running repomix: Permission denied scanning directory '${targetDir}'. Check folder permissions.`
        await logToFile(
          `[RepomixUtil/${logContext}] ${userFriendlyError}`,
          'error'
        )
      }
    }
    if (
      !repomixStdout &&
      !(await fs.stat(repomixOutputPath).catch(() => null))
    ) {
      await logToFile(
        `[RepomixUtil/${logContext}] repomix stdout was empty and output file does not exist.`,
        'warn'
      )
    }

    // Read output file
    try {
      codebaseContext = await fs.readFile(repomixOutputPath, 'utf-8')
    } catch (readError: any) {
      if (readError.code === 'ENOENT') {
        await logToFile(
          `[RepomixUtil/${logContext}] repomix-output.txt not found at ${repomixOutputPath}. Proceeding without context.`,
          'warn'
        )
        codebaseContext = '' // Expected case if repomix finds nothing
      } else {
        // Rethrow unexpected read errors
        throw readError
      }
    }

    if (!codebaseContext.trim()) {
      await logToFile(
        `[RepomixUtil/${logContext}] repomix output file (${repomixOutputPath}) was empty or missing.`,
        'info' // Info level might be sufficient here
      )
      codebaseContext = ''
    } else {
      await logToFile(
        `[RepomixUtil/${logContext}] repomix context gathered (${codebaseContext.length} chars).`,
        'debug'
      )
      // TODO: Add token counting/compression logic here if desired, similar to planFeature
    }
  } catch (error: any) {
    await logToFile(
      `[RepomixUtil/${logContext}] Error running repomix: ${error}`,
      'error'
    )
    if (error.message?.includes('command not found')) {
      userFriendlyError =
        "Error: 'npx' or 'repomix' command not found. Make sure Node.js and repomix are installed and in the PATH."
    } else if (userFriendlyError) {
      // Use the permission denied error if already set
    } else {
      userFriendlyError = 'Error running repomix to gather codebase context.'
    }
    codebaseContext = '' // Ensure context is empty on error
  }

  return { context: codebaseContext, error: userFriendlyError }
}
