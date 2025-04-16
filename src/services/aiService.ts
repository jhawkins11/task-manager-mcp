import {
  GoogleGenerativeAI,
  GenerativeModel,
  GenerateContentResult,
  GoogleGenerativeAIError,
} from '@google/generative-ai'
import OpenAI, { OpenAIError } from 'openai'
import { logToFile } from '../lib/logger'
import {
  GEMINI_API_KEY,
  OPENROUTER_API_KEY,
  GEMINI_MODEL,
  OPENROUTER_MODEL,
  REVIEW_LLM_API_KEY,
  safetySettings,
  FALLBACK_GEMINI_MODEL,
  FALLBACK_OPENROUTER_MODEL,
} from '../config'
import { z } from 'zod'
import { parseAndValidateJsonResponse } from '../lib/llmUtils'

type StructuredCallResult<T extends z.ZodType, R> =
  | { success: true; data: z.infer<T>; rawResponse: R }
  | { success: false; error: string; rawResponse?: R | null }

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
    logToFile(
      `[TaskServer] Planning model: ${JSON.stringify(
        this.openRouter ? 'OpenRouter' : 'Gemini'
      )}`
    )
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
   * Extracts and validates structured data from an AI API result.
   * Handles both OpenRouter and Gemini responses and validates against a schema.
   *
   * @param result The raw API response from either OpenRouter or Gemini
   * @param schema The Zod schema to validate against
   * @returns An object with either validated data or error information
   */
  extractStructuredResponse<T extends z.ZodType>(
    result:
      | GenerateContentResult
      | OpenAI.Chat.Completions.ChatCompletion
      | undefined,
    schema: T
  ):
    | { success: true; data: z.infer<T> }
    | { success: false; error: string; rawData: any | null } {
    // First extract text content using existing method
    const textContent = this.extractTextFromResponse(result)

    // Then parse and validate as JSON against the schema
    return parseAndValidateJsonResponse(textContent, schema)
  }

  /**
   * Makes a structured OpenRouter API call with JSON schema validation
   *
   * @param modelName The model to use for the request
   * @param messages The messages to send to the model
   * @param schema The Zod schema to validate the response against
   * @param options Additional options for the API call
   * @returns A promise that resolves to the validated data or error information
   */
  async callOpenRouterWithSchema<T extends z.ZodType>(
    modelName: string,
    messages: Array<OpenAI.Chat.ChatCompletionMessageParam>,
    schema: T,
    options: {
      temperature?: number
      max_tokens?: number
    } = {},
    isRetry: boolean = false
  ): Promise<StructuredCallResult<T, OpenAI.Chat.Completions.ChatCompletion>> {
    if (!this.openRouter) {
      return {
        success: false,
        error: 'OpenRouter client is not initialized',
        rawResponse: null,
      }
    }

    const currentModel = isRetry ? FALLBACK_OPENROUTER_MODEL : modelName
    await logToFile(
      `[AIService] Calling OpenRouter model: ${currentModel}${
        isRetry ? ' (Fallback)' : ''
      }`
    )

    let response: OpenAI.Chat.Completions.ChatCompletion | null = null
    try {
      response = await this.openRouter.chat.completions.create({
        model: currentModel,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens,
        response_format: { type: 'json_object' },
      })

      const openRouterError = (response as any)?.error
      let responseBodyRateLimitDetected = false

      if (openRouterError) {
        await logToFile(
          `[AIService] OpenRouter response contains error object: ${JSON.stringify(
            openRouterError
          )}`
        )
        if (
          openRouterError.code === 429 ||
          openRouterError.status === 'RESOURCE_EXHAUSTED' ||
          (typeof openRouterError.message === 'string' &&
            openRouterError.message.includes('quota'))
        ) {
          responseBodyRateLimitDetected = true
        }
      }

      if (responseBodyRateLimitDetected && !isRetry) {
        await logToFile(
          `[AIService] Rate limit (429) detected in response body for ${currentModel}. Retrying with fallback ${FALLBACK_OPENROUTER_MODEL}...`
        )
        return this.callOpenRouterWithSchema(
          modelName,
          messages,
          schema,
          options,
          true
        )
      }

      const textContent = this.extractTextFromResponse(response)
      const validationResult = parseAndValidateJsonResponse(textContent, schema)

      if (openRouterError && !validationResult.success) {
        await logToFile(
          `[AIService] Non-retryable error detected in response body for ${currentModel}.`
        )
        return {
          success: false,
          error: `API response contained error: ${
            openRouterError.message || 'Unknown error'
          }`,
          rawResponse: response,
        }
      }

      if (validationResult.success) {
        return {
          success: true,
          data: validationResult.data,
          rawResponse: response,
        }
      } else {
        await logToFile(
          `[AIService] Schema validation failed for ${currentModel}: ${
            validationResult.error
          }. Raw data: ${JSON.stringify(validationResult.rawData)?.substring(
            0,
            200
          )}`
        )
        const errorMessage = openRouterError?.message
          ? `API response contained error: ${openRouterError.message}`
          : validationResult.error
        return {
          success: false,
          error: errorMessage,
          rawResponse: response,
        }
      }
    } catch (error: any) {
      await logToFile(
        `[AIService] API call failed for ${currentModel}. Error: ${
          error.message
        }, Status: ${error.status || 'unknown'}`
      )

      let isRateLimitError = false
      if (error instanceof OpenAIError && (error as any).status === 429) {
        isRateLimitError = true
      } else if (error.status === 429) {
        isRateLimitError = true
      }

      if (isRateLimitError && !isRetry) {
        await logToFile(
          `[AIService] Rate limit hit (thrown error ${
            error.status || 429
          }) for ${currentModel}. Retrying with fallback ${FALLBACK_OPENROUTER_MODEL}...`
        )
        return this.callOpenRouterWithSchema(
          FALLBACK_OPENROUTER_MODEL,
          messages,
          schema,
          options,
          true
        )
      }

      const rawErrorResponse = error?.response
      return {
        success: false,
        error: `API call failed: ${error.message}`,
        rawResponse: rawErrorResponse || null,
      }
    }
  }

  /**
   * Makes a structured Gemini API call with JSON schema validation.
   * Note: Gemini currently has limited built-in JSON schema support,
   * so we use prompt engineering to get structured output.
   *
   * @param modelName The model to use for the request
   * @param prompt The prompt to send to the model
   * @param schema The Zod schema to validate the response against
   * @param options Additional options for the API call
   * @returns A promise that resolves to the validated data or error information
   */
  async callGeminiWithSchema<T extends z.ZodType>(
    modelName: string,
    prompt: string,
    schema: T,
    options: {
      temperature?: number
      maxOutputTokens?: number
    } = {},
    isRetry: boolean = false
  ): Promise<
    | { success: true; data: z.infer<T>; rawResponse: GenerateContentResult }
    | {
        success: false
        error: string
        rawResponse?: GenerateContentResult | null
      }
  > {
    if (!this.genAI) {
      return {
        success: false,
        error: 'Gemini client is not initialized',
        rawResponse: null,
      }
    }

    const currentModelName = isRetry ? FALLBACK_GEMINI_MODEL : modelName
    await logToFile(
      `[AIService] Calling Gemini model: ${currentModelName}${
        isRetry ? ' (Fallback)' : ''
      }`
    )

    const schemaDescription = this.createSchemaDescription(schema)
    const enhancedPrompt = `${prompt}\n\nYour response must be a valid JSON object with the following structure:\n${schemaDescription}\n\nEnsure your response is valid JSON with no markdown formatting or additional text.`

    try {
      const model = this.genAI.getGenerativeModel({ model: currentModelName })
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: enhancedPrompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxOutputTokens,
        },
        safetySettings,
      })

      const textContent = this.extractTextFromResponse(response)
      const validationResult = parseAndValidateJsonResponse(textContent, schema)

      if (validationResult.success) {
        return {
          success: true,
          data: validationResult.data,
          rawResponse: response,
        }
      } else {
        await logToFile(
          `[AIService] Schema validation failed for ${currentModelName}: ${
            validationResult.error
          }. Raw data: ${JSON.stringify(validationResult.rawData)?.substring(
            0,
            200
          )}`
        )
        return {
          success: false,
          error: validationResult.error,
          rawResponse: response,
        }
      }
    } catch (error: any) {
      await logToFile(
        `[AIService] API call failed for ${currentModelName}. Error: ${error.message}`
      )

      let isRateLimitError = false
      if (
        error instanceof GoogleGenerativeAIError &&
        error.message.includes('RESOURCE_EXHAUSTED')
      ) {
        isRateLimitError = true
      } else if (error.status === 429) {
        isRateLimitError = true
      }

      if (isRateLimitError && !isRetry) {
        await logToFile(
          `[AIService] Rate limit hit for ${currentModelName}. Retrying with fallback model ${FALLBACK_GEMINI_MODEL}...`
        )
        return this.callGeminiWithSchema(
          FALLBACK_GEMINI_MODEL,
          prompt,
          schema,
          options,
          true
        )
      }

      return {
        success: false,
        error: `API call failed: ${error.message}`,
        rawResponse: null,
      }
    }
  }

  /**
   * Creates a human-readable description of a Zod schema for prompt engineering
   */
  private createSchemaDescription(schema: z.ZodType): string {
    // Use the schema describe functionality to extract metadata
    const description = schema._def.description ?? 'JSON object'

    // For object schemas, extract shape information
    if (schema instanceof z.ZodObject) {
      const shape = schema._def.shape()
      const fields = Object.entries(shape).map(([key, field]) => {
        const fieldType = this.getZodTypeDescription(field as z.ZodType)
        const fieldDesc = (field as z.ZodType)._def.description || ''
        return `  "${key}": ${fieldType}${fieldDesc ? ` // ${fieldDesc}` : ''}`
      })

      return `{\n${fields.join(',\n')}\n}`
    }

    // For array schemas
    if (schema instanceof z.ZodArray) {
      const elementType = this.getZodTypeDescription(schema._def.type)
      return `[\n  ${elementType} // Array of items\n]`
    }

    // For other types
    return description
  }

  /**
   * Gets a simple description of a Zod type for schema representation
   */
  private getZodTypeDescription(schema: z.ZodType): string {
    if (schema instanceof z.ZodString) return '"string"'
    if (schema instanceof z.ZodNumber) return 'number'
    if (schema instanceof z.ZodBoolean) return 'boolean'
    if (schema instanceof z.ZodArray) {
      const elementType = this.getZodTypeDescription(schema._def.type)
      return `[${elementType}]`
    }
    if (schema instanceof z.ZodObject) {
      const shape = schema._def.shape()
      const fields = Object.entries(shape).map(([key]) => `"${key}"`)
      return `{ ${fields.join(', ')} }`
    }
    if (schema instanceof z.ZodEnum) {
      const values = schema._def.values.map((v: string) => `"${v}"`)
      return `one of: ${values.join(' | ')}`
    }

    return 'any'
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
