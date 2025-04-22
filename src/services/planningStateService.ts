import { IntermediatePlanningState } from '../models/types'
import { logToFile } from '../lib/logger'
import crypto from 'crypto'
import {
  addPlanningState,
  getPlanningStateByQuestionId,
  getPlanningStateByFeatureId,
  clearPlanningState,
  clearPlanningStatesForFeature,
} from '../lib/dbUtils'

/**
 * Service for managing intermediate planning state when LLM needs clarification
 */
class PlanningStateService {
  /**
   * Stores intermediate planning state when LLM needs clarification
   *
   * @param featureId The feature ID being planned
   * @param prompt The original prompt that led to the question
   * @param partialResponse The LLM's partial response including the question
   * @param planningType The type of planning operation (feature planning or adjustment)
   * @returns The generated question ID
   */
  async storeIntermediateState(
    featureId: string,
    prompt: string,
    partialResponse: string,
    planningType: 'feature_planning' | 'plan_adjustment'
  ): Promise<string> {
    try {
      const questionId = await addPlanningState(
        featureId,
        prompt,
        partialResponse,
        planningType
      )

      logToFile(
        `[PlanningStateService] Stored intermediate state for question ${questionId}, feature ${featureId}`
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
  async getStateByQuestionId(
    questionId: string
  ): Promise<IntermediatePlanningState | null> {
    try {
      if (!questionId) {
        logToFile(
          `[PlanningStateService] Cannot retrieve state with empty questionId`
        )
        return null
      }

      const state = await getPlanningStateByQuestionId(questionId)

      if (!state) {
        logToFile(
          `[PlanningStateService] No intermediate state found for question ${questionId}`
        )
        return null
      }

      // Map the database planning state to IntermediatePlanningState
      const intermediateState: IntermediatePlanningState = {
        questionId: state.questionId,
        featureId: state.featureId,
        prompt: state.prompt,
        partialResponse: state.partialResponse,
        planningType: state.planningType,
      }

      logToFile(
        `[PlanningStateService] Retrieved intermediate state for question ${questionId}, feature ${state.featureId}`
      )

      return intermediateState
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
  async getStateByFeatureId(
    featureId: string
  ): Promise<IntermediatePlanningState | null> {
    try {
      if (!featureId) {
        logToFile(
          `[PlanningStateService] Cannot retrieve state with empty featureId`
        )
        return null
      }

      const state = await getPlanningStateByFeatureId(featureId)

      if (!state) {
        logToFile(
          `[PlanningStateService] No intermediate state found for feature ${featureId}`
        )
        return null
      }

      // Map the database planning state to IntermediatePlanningState
      const intermediateState: IntermediatePlanningState = {
        questionId: state.questionId,
        featureId: state.featureId,
        prompt: state.prompt,
        partialResponse: state.partialResponse,
        planningType: state.planningType,
      }

      logToFile(
        `[PlanningStateService] Retrieved intermediate state for feature ${featureId}`
      )

      return intermediateState
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
  async clearState(questionId: string): Promise<boolean> {
    try {
      if (!questionId) {
        logToFile(
          `[PlanningStateService] Cannot clear state with empty questionId`
        )
        return false
      }

      // Get the state first to log the feature ID
      const state = await this.getStateByQuestionId(questionId)

      if (!state) {
        logToFile(
          `[PlanningStateService] No intermediate state to clear for question ${questionId}`
        )
        return false
      }

      const cleared = await clearPlanningState(questionId)

      if (cleared) {
        logToFile(
          `[PlanningStateService] Cleared intermediate state for question ${questionId}, feature ${state.featureId}`
        )
        return true
      }

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
  async clearStatesForFeature(featureId: string): Promise<number> {
    try {
      if (!featureId) {
        logToFile(
          `[PlanningStateService] Cannot clear states with empty featureId`
        )
        return 0
      }

      const count = await clearPlanningStatesForFeature(featureId)

      logToFile(
        `[PlanningStateService] Cleared ${count} intermediate states for feature ${featureId}`
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
