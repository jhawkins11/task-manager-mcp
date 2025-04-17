import { WebSocket, WebSocketServer } from 'ws'
import { UI_PORT } from '../config'
import { logToFile } from '../lib/logger'
import {
  WebSocketMessage,
  WebSocketMessageType,
  ClientRegistrationPayload,
  ErrorPayload,
  ShowQuestionPayload,
  QuestionResponsePayload,
  PlanFeatureResponseSchema,
  IntermediatePlanningState,
} from '../models/types'
import planningStateService from '../services/planningStateService'
import { aiService } from '../services/aiService'
import { OPENROUTER_MODEL, GEMINI_MODEL } from '../config'
import { addHistoryEntry, writeTasks } from '../lib/fsUtils'
import crypto from 'crypto'
import {
  processAndBreakdownTasks,
  ensureEffortRatings,
  processAndFinalizePlan,
} from '../lib/llmUtils'
import OpenAI from 'openai'
import { GenerativeModel } from '@google/generative-ai'
import { z } from 'zod'

interface WebSocketConnection {
  socket: WebSocket
  featureId?: string
  clientId?: string
  lastActivity: Date
}

class WebSocketService {
  private wss: WebSocketServer | null = null
  private connections: Map<WebSocket, WebSocketConnection> = new Map()
  private static instance: WebSocketService
  private isInitialized = false

  private constructor() {}

  /**
   * Returns the singleton instance of WebSocketService
   */
  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService()
    }
    return WebSocketService.instance
  }

  /**
   * Initializes the WebSocket server using an existing HTTP server
   *
   * @param httpServer The Node.js HTTP server instance from Express
   */
  public async initialize(httpServer: import('http').Server): Promise<void> {
    if (this.isInitialized) {
      await logToFile(
        '[WebSocketService] WebSocket server already initialized.'
      )
      return
    }

    try {
      // Attach WebSocket server to the existing HTTP server
      this.wss = new WebSocketServer({ server: httpServer })

      // Use UI_PORT for logging consistency if needed
      await logToFile(
        `[WebSocketService] WebSocket server attached to HTTP server on port ${UI_PORT}`
      )

      this.wss.on('connection', this.handleConnection.bind(this))
      this.wss.on('error', this.handleServerError.bind(this))

      // Set up connection cleanup interval (runs every minute)
      setInterval(this.cleanupInactiveConnections.bind(this), 60000)

      this.isInitialized = true
    } catch (error) {
      await logToFile(
        `[WebSocketService] Failed to initialize WebSocket server: ${error}`
      )
      throw error
    }
  }

  /**
   * Handles new WebSocket connections
   */
  private handleConnection(socket: WebSocket, _request: any): void {
    // Create a new connection entry
    const connection: WebSocketConnection = {
      socket,
      lastActivity: new Date(),
    }

    this.connections.set(socket, connection)

    logToFile(
      `[WebSocketService] New client connected. Total connections: ${this.connections.size}`
    )

    // Send a connection established message
    this.sendToSocket(socket, {
      type: 'connection_established',
    })

    // Set up event listeners for the socket
    socket.on('message', (data: Buffer) => this.handleMessage(socket, data))
    socket.on('close', () => this.handleDisconnect(socket))
    socket.on('error', (error) => this.handleSocketError(socket, error))
  }

  /**
   * Handles incoming WebSocket messages
   */
  private handleMessage(socket: WebSocket, data: Buffer): void {
    try {
      // Update last activity timestamp
      const connection = this.connections.get(socket)
      if (connection) {
        connection.lastActivity = new Date()
      }

      // Parse the message
      const message = JSON.parse(data.toString()) as WebSocketMessage

      // Handle client registration
      if (message.type === 'client_registration' && message.payload) {
        this.handleClientRegistration(
          socket,
          message.payload as ClientRegistrationPayload
        )
        return
      }

      // Handle question response
      if (message.type === 'question_response' && message.payload) {
        this.handleQuestionResponse(
          message.featureId || '',
          message.payload as QuestionResponsePayload
        )
        return
      }

      // Log the message type
      logToFile(`[WebSocketService] Received message of type: ${message.type}`)

      // Additional message handling logic can be added here
    } catch (error) {
      logToFile(`[WebSocketService] Error handling message: ${error}`)
      this.sendToSocket(socket, {
        type: 'error',
        payload: {
          code: 'MESSAGE_PARSING_ERROR',
          message: 'Failed to parse incoming message',
        } as ErrorPayload,
      })
    }
  }

  /**
   * Handles client registration messages
   */
  private handleClientRegistration(
    socket: WebSocket,
    payload: ClientRegistrationPayload
  ): void {
    const connection = this.connections.get(socket)

    if (connection) {
      connection.featureId = payload.featureId
      connection.clientId = payload.clientId || `client-${Date.now()}`

      logToFile(
        `[WebSocketService] Client registered: ${connection.clientId} for feature: ${connection.featureId}`
      )

      // Confirm registration to the client
      this.sendToSocket(socket, {
        type: 'client_registration',
        featureId: connection.featureId,
        payload: {
          featureId: connection.featureId,
          clientId: connection.clientId,
        },
      })
    }
  }

  /**
   * Handles socket disconnections
   */
  private handleDisconnect(socket: WebSocket): void {
    const connection = this.connections.get(socket)

    if (connection) {
      logToFile(
        `[WebSocketService] Client disconnected: ${
          connection.clientId || 'unknown'
        }`
      )
      this.connections.delete(socket)
    }
  }

  /**
   * Handles socket errors
   */
  private handleSocketError(socket: WebSocket, error: Error): void {
    const connection = this.connections.get(socket)

    logToFile(
      `[WebSocketService] Socket error for client ${
        connection?.clientId || 'unknown'
      }: ${error.message}`
    )

    // Try to send an error message to the client
    this.sendToSocket(socket, {
      type: 'error',
      payload: {
        code: 'SOCKET_ERROR',
        message: 'Socket error occurred',
      } as ErrorPayload,
    })

    // Close the connection after an error
    try {
      socket.terminate()
    } catch (closeError) {
      logToFile(`[WebSocketService] Error closing socket: ${closeError}`)
    }

    // Remove the connection from our map
    this.connections.delete(socket)
  }

  /**
   * Handles server errors
   */
  private async handleServerError(error: Error): Promise<void> {
    await logToFile(
      `[WebSocketService] WebSocket server error: ${error.message}`
    )
  }

  /**
   * Cleans up inactive connections
   */
  private cleanupInactiveConnections(): void {
    const now = new Date()
    const inactivityThreshold = 30 * 60 * 1000 // 30 minutes

    for (const [socket, connection] of this.connections.entries()) {
      const timeSinceLastActivity =
        now.getTime() - connection.lastActivity.getTime()

      if (timeSinceLastActivity > inactivityThreshold) {
        logToFile(
          `[WebSocketService] Closing inactive connection: ${
            connection.clientId || 'unknown'
          }`
        )

        try {
          socket.terminate()
        } catch (error) {
          logToFile(
            `[WebSocketService] Error terminating inactive socket: ${error}`
          )
        }

        this.connections.delete(socket)
      }
    }
  }

  /**
   * Sends a message to all connected clients for a specific feature
   */
  public broadcast(message: WebSocketMessage): void {
    if (!message.featureId) {
      logToFile('[WebSocketService] Cannot broadcast without featureId')
      return
    }

    let recipientCount = 0

    for (const [socket, connection] of this.connections.entries()) {
      // Only send to clients registered for this feature
      if (connection.featureId === message.featureId) {
        this.sendToSocket(socket, message)
        recipientCount++
      }
    }

    logToFile(
      `[WebSocketService] Broadcast message of type '${message.type}' to ${recipientCount} clients for feature: ${message.featureId}`
    )
  }

  /**
   * Sends a message to a specific socket
   */
  private sendToSocket(socket: WebSocket, message: WebSocketMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message))
      } catch (error) {
        logToFile(
          `[WebSocketService] Error sending message to socket: ${error}`
        )
      }
    }
  }

  /**
   * Gracefully shutdowns the WebSocket server
   */
  public async shutdown(): Promise<void> {
    if (!this.wss) {
      return
    }

    await logToFile('[WebSocketService] Shutting down WebSocket server...')

    // Close all connections
    for (const [socket] of this.connections.entries()) {
      try {
        socket.terminate()
      } catch (error) {
        await logToFile(
          `[WebSocketService] Error terminating socket during shutdown: ${error}`
        )
      }
    }

    this.connections.clear()

    // Close the server
    this.wss.close((error) => {
      if (error) {
        logToFile(`[WebSocketService] Error closing WebSocket server: ${error}`)
      } else {
        logToFile('[WebSocketService] WebSocket server closed successfully')
      }
    })

    this.wss = null
    this.isInitialized = false
  }

  /**
   * Broadcasts a task update notification for a feature
   */
  public notifyTasksUpdated(featureId: string, tasks: any): void {
    this.broadcast({
      type: 'tasks_updated',
      featureId,
      payload: {
        tasks,
        updatedAt: new Date().toISOString(),
      },
    })
  }

  /**
   * Broadcasts a task status change notification
   */
  public notifyTaskStatusChanged(
    featureId: string,
    taskId: string,
    status: 'pending' | 'completed'
  ): void {
    this.broadcast({
      type: 'status_changed',
      featureId,
      payload: {
        taskId,
        status,
        updatedAt: new Date().toISOString(),
      },
    })
  }

  /**
   * Sends a question to UI clients
   */
  public sendQuestion(
    featureId: string,
    questionId: string,
    question: string,
    options?: string[],
    allowsText?: boolean
  ): void {
    try {
      if (!featureId || !questionId || !question) {
        logToFile(
          '[WebSocketService] Cannot send question: Missing required parameters'
        )
        return
      }

      // Check if any clients are connected for this feature
      let featureClients = 0
      for (const connection of this.connections.values()) {
        if (connection.featureId === featureId) {
          featureClients++
        }
      }

      // Log if no clients are available
      if (featureClients === 0) {
        logToFile(
          `[WebSocketService] Warning: Sending question ${questionId} to feature ${featureId} with no connected clients`
        )
      }

      this.broadcast({
        type: 'show_question',
        featureId,
        payload: {
          questionId,
          question,
          options,
          allowsText,
        } as ShowQuestionPayload,
      })

      logToFile(
        `[WebSocketService] Sent question to ${featureClients} clients for feature ${featureId}: ${question}`
      )
    } catch (error: any) {
      logToFile(`[WebSocketService] Error sending question: ${error.message}`)
    }
  }

  /**
   * Requests a screenshot from UI clients
   */
  public requestScreenshot(
    featureId: string,
    requestId: string,
    target?: string
  ): void {
    this.broadcast({
      type: 'request_screenshot',
      featureId,
      payload: {
        requestId,
        target,
      },
    })
  }

  /**
   * Handles user responses to questions
   */
  private async handleQuestionResponse(
    featureId: string,
    payload: QuestionResponsePayload
  ): Promise<void> {
    try {
      if (!featureId) {
        logToFile(
          '[WebSocketService] Cannot handle question response: Missing featureId'
        )
        return
      }

      const { questionId, response } = payload

      if (!questionId) {
        logToFile(
          '[WebSocketService] Cannot handle question response: Missing questionId'
        )
        this.broadcast({
          type: 'error',
          featureId,
          payload: {
            code: 'INVALID_RESPONSE',
            message: 'Invalid response format: missing questionId',
          } as ErrorPayload,
        })
        return
      }

      logToFile(
        `[WebSocketService] Received response to question ${questionId}: ${response}`
      )

      // Get the stored planning state
      const state = planningStateService.getStateByQuestionId(questionId)

      if (!state) {
        logToFile(
          `[WebSocketService] No planning state found for question ${questionId}`
        )
        this.broadcast({
          type: 'error',
          featureId,
          payload: {
            code: 'QUESTION_EXPIRED',
            message: 'The question session has expired or is invalid.',
          } as ErrorPayload,
        })
        return
      }

      // Verify feature ID matches
      if (state.featureId !== featureId) {
        logToFile(
          `[WebSocketService] Feature ID mismatch: question belongs to ${state.featureId}, but response came from ${featureId}`
        )
        this.broadcast({
          type: 'error',
          featureId,
          payload: {
            code: 'FEATURE_MISMATCH',
            message:
              'Response came from a different feature than the question.',
          } as ErrorPayload,
        })
        return
      }

      // Add the response to history
      await addHistoryEntry(featureId, 'user', {
        questionId,
        question: state.partialResponse,
        response,
      })

      // Notify UI that response is being processed
      this.broadcast({
        type: 'status_changed',
        featureId,
        payload: {
          status: 'processing_response',
          questionId,
        },
      })

      // Resume planning/adjustment with the user's response
      try {
        const planningModel = aiService.getPlanningModel()
        if (!planningModel) {
          throw new Error('Planning model not available')
        }

        logToFile(
          `[WebSocketService] Resuming ${state.planningType} with user response for feature ${featureId}`
        )

        // Create a follow-up prompt including the original prompt and the user's answer
        const followUpPrompt = `${state.prompt}\n\nUser clarification response: ${response}\n\nNow, please continue with the original task of planning the feature implementation steps.`

        // Call the LLM with the follow-up prompt
        if (planningModel instanceof OpenAI) {
          await this.processOpenRouterResumeResponse(
            planningModel,
            followUpPrompt,
            state,
            featureId,
            questionId
          )
        } else {
          await this.processGeminiResumeResponse(
            planningModel,
            followUpPrompt,
            state,
            featureId,
            questionId
          )
        }
      } catch (error: any) {
        logToFile(
          `[WebSocketService] Error resuming planning: ${error.message}`
        )

        // Notify clients of the error
        this.broadcast({
          type: 'error',
          featureId,
          payload: {
            code: 'RESUME_PLANNING_FAILED',
            message: `Failed to process your response: ${error.message}`,
          } as ErrorPayload,
        })

        // Add error history entry
        await addHistoryEntry(featureId, 'tool_response', {
          tool:
            state.planningType === 'feature_planning'
              ? 'plan_feature'
              : 'adjust_plan',
          status: 'failed_after_clarification',
          error: error.message,
        })
      }
    } catch (error: any) {
      logToFile(
        `[WebSocketService] Unhandled error in question response handler: ${error.message}`
      )
      if (featureId) {
        this.broadcast({
          type: 'error',
          featureId,
          payload: {
            code: 'INTERNAL_ERROR',
            message:
              'An internal error occurred while processing your response.',
          } as ErrorPayload,
        })
      }
    }
  }

  /**
   * Process OpenRouter response for resuming planning after clarification
   */
  private async processOpenRouterResumeResponse(
    model: OpenAI,
    prompt: string,
    state: IntermediatePlanningState,
    featureId: string,
    questionId: string
  ): Promise<void> {
    try {
      logToFile(
        `[WebSocketService] Calling OpenRouter with follow-up prompt for feature ${featureId}`
      )

      const result = await aiService.callOpenRouterWithSchema(
        OPENROUTER_MODEL,
        [{ role: 'user', content: prompt }],
        PlanFeatureResponseSchema,
        { temperature: 0.3 }
      )

      if (result.success) {
        await this.processPlanningSuccess(
          result.data,
          model,
          state,
          featureId,
          questionId
        )
      } else {
        throw new Error(
          `OpenRouter failed to generate a valid response: ${result.error}`
        )
      }
    } catch (error: any) {
      logToFile(
        `[WebSocketService] Error in OpenRouter response processing: ${error.message}`
      )
      throw error // Re-throw to be handled by the caller
    }
  }

  /**
   * Process Gemini response for resuming planning after clarification
   */
  private async processGeminiResumeResponse(
    model: GenerativeModel,
    prompt: string,
    state: IntermediatePlanningState,
    featureId: string,
    questionId: string
  ): Promise<void> {
    try {
      logToFile(
        `[WebSocketService] Calling Gemini with follow-up prompt for feature ${featureId}`
      )

      const result = await aiService.callGeminiWithSchema(
        GEMINI_MODEL,
        prompt,
        PlanFeatureResponseSchema,
        { temperature: 0.3 }
      )

      if (result.success) {
        await this.processPlanningSuccess(
          result.data,
          model,
          state,
          featureId,
          questionId
        )
      } else {
        throw new Error(
          `Gemini failed to generate a valid response: ${result.error}`
        )
      }
    } catch (error: any) {
      logToFile(
        `[WebSocketService] Error in Gemini response processing: ${error.message}`
      )
      throw error // Re-throw to be handled by the caller
    }
  }

  /**
   * Process successful planning result after clarification
   */
  private async processPlanningSuccess(
    data: z.infer<typeof PlanFeatureResponseSchema>,
    model: GenerativeModel | OpenAI,
    state: IntermediatePlanningState,
    featureId: string,
    questionId: string
  ): Promise<void> {
    try {
      // Check if tasks exist before processing
      if (!data.tasks) {
        logToFile(
          `[WebSocketService] Error: processPlanningSuccess called but response contained clarificationNeeded instead of tasks for feature ${featureId}`
        )
        // Optionally, you could try to handle the clarification again here, but throwing seems safer
        throw new Error(
          'processPlanningSuccess received clarification request, expected tasks.'
        )
      }

      // Process the tasks using schema data
      const rawPlanSteps = data.tasks.map(
        (task: { effort: string; description: string }) =>
          `[${task.effort}] ${task.description}`
      )

      // Log the result before detailed processing
      await addHistoryEntry(featureId, 'model', {
        step: 'resumed_planning_response',
        response: JSON.stringify(data),
      })

      logToFile(
        `[WebSocketService] Got ${rawPlanSteps.length} raw tasks after clarification for feature ${featureId}`
      )

      // Call the centralized processing function
      const finalTasks = await processAndFinalizePlan(
        rawPlanSteps,
        model,
        featureId
      )

      logToFile(
        `[WebSocketService] Processed ${finalTasks.length} final tasks after clarification for feature ${featureId}`
      )

      // Clean up the temporary state
      planningStateService.clearState(questionId)

      // Add success history entry (notification/saving is now handled within processAndFinalizePlan)
      await addHistoryEntry(featureId, 'tool_response', {
        tool:
          state.planningType === 'feature_planning'
            ? 'plan_feature'
            : 'adjust_plan',
        status: 'completed_after_clarification',
        taskCount: finalTasks.length,
      })

      logToFile(
        `[WebSocketService] Successfully completed ${state.planningType} after clarification for feature ${featureId}`
      )
    } catch (error: any) {
      logToFile(
        `[WebSocketService] Error processing successful planning result: ${error.message}`
      )
      throw error // Re-throw to be handled by the caller
    }
  }
}

export default WebSocketService.getInstance()
