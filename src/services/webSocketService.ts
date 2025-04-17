import { WebSocket, WebSocketServer } from 'ws'
import { UI_PORT } from '../config'
import { logToFile } from '../lib/logger'
import {
  WebSocketMessage,
  WebSocketMessageType,
  ClientRegistrationPayload,
  ErrorPayload,
} from '../models/types'

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
    options?: string[]
  ): void {
    this.broadcast({
      type: 'show_question',
      featureId,
      payload: {
        questionId,
        question,
        options,
      },
    })
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
}

export default WebSocketService.getInstance()
