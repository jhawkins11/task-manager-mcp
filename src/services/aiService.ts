import {
  GoogleGenerativeAI,
  GenerativeModel,
  GenerateContentResult,
} from '@google/generative-ai'
import OpenAI from 'openai'
import { logToFile } from '../lib/logger'
import {
  GEMINI_API_KEY,
  OPENROUTER_API_KEY,
  GEMINI_MODEL,
  OPENROUTER_MODEL,
  REVIEW_LLM_API_KEY,
  safetySettings,
} from '../config'

// Class to manage AI models and provide access to them
class AIService {
  private genAI: GoogleGenerativeAI | null = null
  private openRouter: OpenAI | null = null
  private planningModel: GenerativeModel | undefined
  private reviewModel: GenerativeModel | undefined
  private initialized = false

  constructor() {
    this.initialize()
  }

  private initialize(): void {
    // Initialize OpenRouter if API key is available
    if (OPENROUTER_API_KEY) {
      try {
        this.openRouter = new OpenAI({
          apiKey: OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api/v1',
        })
        console.error(
          '[TaskServer] LOG: OpenRouter SDK initialized successfully.'
        )
      } catch (sdkError) {
        console.error(
          '[TaskServer] CRITICAL ERROR initializing OpenRouter SDK:',
          sdkError
        )
      }
    } else if (GEMINI_API_KEY) {
      try {
        this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
        // Configure the model.
        this.planningModel = this.genAI.getGenerativeModel({
          model: GEMINI_MODEL,
        })
        this.reviewModel = this.genAI.getGenerativeModel({
          model: GEMINI_MODEL,
        })
        console.error(
          '[TaskServer] LOG: Google AI SDK initialized successfully.'
        )
      } catch (sdkError) {
        console.error(
          '[TaskServer] CRITICAL ERROR initializing Google AI SDK:',
          sdkError
        )
      }
    } else {
      console.error(
        '[TaskServer] WARNING: Neither OPENROUTER_API_KEY nor GEMINI_API_KEY environment variable is set. API calls will fail.'
      )
    }

    this.initialized = true
  }

  /**
   * Gets the appropriate planning model for task planning
   */
  getPlanningModel(): GenerativeModel | OpenAI | null {
    return this.openRouter || this.planningModel || null
  }

  /**
   * Gets the appropriate review model for code reviews
   */
  getReviewModel(): GenerativeModel | OpenAI | null {
    return this.openRouter || this.reviewModel || null
  }

  /**
   * Extracts the text content from an AI API result.
   * Handles both OpenRouter and Gemini responses.
   */
  extractTextFromResponse(
    result:
      | GenerateContentResult
      | OpenAI.Chat.Completions.ChatCompletion
      | undefined
  ): string | null {
    // For OpenRouter responses
    if (
      result &&
      'choices' in result &&
      result.choices &&
      result.choices.length > 0
    ) {
      const choice = result.choices[0]
      if (choice.message && choice.message.content) {
        return choice.message.content
      }
      return null
    }

    // For Gemini responses
    if (result && 'response' in result) {
      try {
        const response = result.response
        if (response.promptFeedback?.blockReason) {
          console.error(
            `[TaskServer] Gemini response blocked: ${response.promptFeedback.blockReason}`
          )
          return null
        }
        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0]
          if (candidate.content?.parts?.[0]?.text) {
            return candidate.content.parts[0].text
          }
        }
        console.error(
          '[TaskServer] No text content found in Gemini response candidate.'
        )
        return null
      } catch (error) {
        console.error(
          '[TaskServer] Error extracting text from Gemini response:',
          error
        )
        return null
      }
    }

    return null
  }

  /**
   * Checks if the service is properly initialized
   */
  isInitialized(): boolean {
    return this.initialized && (!!this.openRouter || !!this.planningModel)
  }
}

// Export a singleton instance
export const aiService = new AIService()
