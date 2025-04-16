import { logToFile } from './logger'

/**
 * Dynamically imports an ES Module from a CommonJS module.
 * Handles default exports correctly.
 * @param modulePath The path or name of the module to import.
 * @returns The default export of the module.
 * @throws If the import fails.
 */
export async function dynamicImportDefault<T = any>(
  modulePath: string
): Promise<T> {
  try {
    // Perform the dynamic import
    const module = await import(modulePath)

    // Check for and return the default export
    if (module.default) {
      return module.default as T
    }

    // If no default export, return the module namespace object itself
    // (less likely needed for 'open', but good fallback)
    return module as T
  } catch (error: any) {
    await logToFile(
      `[Utils] Failed to dynamically import '${modulePath}': ${error.message}`
    )
    console.error(`[Utils] Dynamic import error for '${modulePath}':`, error)
    // Re-throw the error so the calling function knows it failed
    throw error
  }
}
