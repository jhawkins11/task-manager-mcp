import { databaseService } from '../services/databaseService'

/**
 * Adds a new entry to the feature history using the database service
 * @param featureId The unique ID of the feature
 * @param role The role of the entry ('user', 'model', 'tool_call', 'tool_response')
 * @param content The content of the entry
 */
export async function addHistoryEntry(
  featureId: string,
  role: 'user' | 'model' | 'tool_call' | 'tool_response',
  content: any
): Promise<void> {
  try {
    // Convert timestamp to number if not already
    const timestamp = Math.floor(Date.now() / 1000)

    // Prepare history entry
    const entry = {
      timestamp,
      role,
      content,
      feature_id: featureId,
    }

    // Connect to database
    await databaseService.connect()

    // Add entry
    await databaseService.addHistoryEntry(entry)

    // Close connection
    await databaseService.close()
  } catch (error) {
    console.error(
      `[TaskServer] Error adding history entry to database: ${error}`
    )
  }
}
