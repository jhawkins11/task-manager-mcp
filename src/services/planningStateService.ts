import { IntermediatePlanningState } from '../models/types'
import { logToFile } from '../lib/logger'
import crypto from 'crypto'

/**
 * Service for managing intermediate planning state when LLM needs clarification
 */
class PlanningStateService {
  // In-memory store for intermediate planning states
  private planningStates: Map<string, IntermediatePlanningState> = new Map()

  /**
   * Stores intermediate planning state when LLM needs clarification
   *
   * @param featureId The feature ID being planned
   * @param prompt The original prompt that led to the question
   * @param partialResponse The LLM's partial response including the question
   * @param planningType The type of planning operation (feature planning or adjustment)
   * @returns The generated question ID
   */
  storeIntermediateState(
    featureId: string,
    prompt: string,
    partialResponse: string,
    planningType: 'feature_planning' | 'plan_adjustment'
  ): string {
    try {
      // Generate a unique question ID
      const questionId = crypto.randomUUID()

      const state: IntermediatePlanningState = {
        featureId,
        prompt,
        partialResponse,
        questionId,
        planningType,
      }

      this.planningStates.set(questionId, state)

      logToFile(
        `[PlanningStateService] Stored intermediate state for question ${questionId}, feature ${featureId}`
      )
      logToFile(
        `[PlanningStateService] Current active planning states: ${this.planningStates.size}`
      )

      return questionId
    } catch (error: any) {
      logToFile(
        `[PlanningStateService] Error storing intermediate state: ${error.message}`
      )
      // Generate a questionId even in error case to avoid breaking the flow
      return crypto.randomUUID()
    }
  }

  /**
   * Retrieves intermediate planning state by question ID
   *
   * @param questionId The ID of the clarification question
   * @returns The intermediate planning state if found, null otherwise
   */
  getStateByQuestionId(questionId: string): IntermediatePlanningState | null {
    try {
      if (!questionId) {
        logToFile(
          `[PlanningStateService] Cannot retrieve state with empty questionId`
        )
        return null
      }

      const state = this.planningStates.get(questionId)

      if (!state) {
        logToFile(
          `[PlanningStateService] No intermediate state found for question ${questionId}`
        )
        return null
      }

      logToFile(
        `[PlanningStateService] Retrieved intermediate state for question ${questionId}, feature ${state.featureId}`
      )

      return state
    } catch (error: any) {
      logToFile(
        `[PlanningStateService] Error retrieving state for question ${questionId}: ${error.message}`
      )
      return null
    }
  }

  /**
   * Retrieves intermediate planning state by feature ID
   *
   * @param featureId The feature ID
   * @returns The intermediate planning state if found, null otherwise
   */
  getStateByFeatureId(featureId: string): IntermediatePlanningState | null {
    try {
      if (!featureId) {
        logToFile(
          `[PlanningStateService] Cannot retrieve state with empty featureId`
        )
        return null
      }

      // Find the first state with matching feature ID
      for (const state of this.planningStates.values()) {
        if (state.featureId === featureId) {
          logToFile(
            `[PlanningStateService] Retrieved intermediate state for feature ${featureId}`
          )
          return state
        }
      }

      logToFile(
        `[PlanningStateService] No intermediate state found for feature ${featureId}`
      )
      return null
    } catch (error: any) {
      logToFile(
        `[PlanningStateService] Error retrieving state for feature ${featureId}: ${error.message}`
      )
      return null
    }
  }

  /**
   * Clears intermediate planning state after it's no longer needed
   *
   * @param questionId The ID of the clarification question
   * @returns True if the state was cleared, false if not found
   */
  clearState(questionId: string): boolean {
    try {
      if (!questionId) {
        logToFile(
          `[PlanningStateService] Cannot clear state with empty questionId`
        )
        return false
      }

      const exists = this.planningStates.has(questionId)

      if (exists) {
        const state = this.planningStates.get(questionId)
        this.planningStates.delete(questionId)
        logToFile(
          `[PlanningStateService] Cleared intermediate state for question ${questionId}, feature ${state?.featureId}`
        )
        logToFile(
          `[PlanningStateService] Remaining active planning states: ${this.planningStates.size}`
        )
        return true
      }

      logToFile(
        `[PlanningStateService] No intermediate state to clear for question ${questionId}`
      )
      return false
    } catch (error: any) {
      logToFile(
        `[PlanningStateService] Error clearing state for question ${questionId}: ${error.message}`
      )
      return false
    }
  }

  /**
   * Clears all states for a specific feature
   *
   * @param featureId The feature ID to clear states for
   * @returns Number of states cleared
   */
  clearStatesForFeature(featureId: string): number {
    try {
      if (!featureId) {
        logToFile(
          `[PlanningStateService] Cannot clear states with empty featureId`
        )
        return 0
      }

      let count = 0
      const questionIdsToRemove: string[] = []

      // Find all states with matching feature ID
      for (const [questionId, state] of this.planningStates.entries()) {
        if (state.featureId === featureId) {
          questionIdsToRemove.push(questionId)
        }
      }

      // Remove collected question IDs
      for (const questionId of questionIdsToRemove) {
        this.planningStates.delete(questionId)
        count++
      }

      logToFile(
        `[PlanningStateService] Cleared ${count} intermediate states for feature ${featureId}`
      )
      logToFile(
        `[PlanningStateService] Remaining active planning states: ${this.planningStates.size}`
      )

      return count
    } catch (error: any) {
      logToFile(
        `[PlanningStateService] Error clearing states for feature ${featureId}: ${error.message}`
      )
      return 0
    }
  }
}

// Singleton instance
const planningStateService = new PlanningStateService()
export default planningStateService
