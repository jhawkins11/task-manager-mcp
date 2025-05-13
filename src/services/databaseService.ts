import sqlite3 from 'sqlite3'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import { SQLITE_DB_PATH } from '../config'
import logger from '../lib/winstonLogger'

// Define Task type for database operations
interface Task {
  id: string
  title?: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'decomposed'
  completed: boolean
  effort?: 'low' | 'medium' | 'high'
  feature_id?: string
  parent_task_id?: string
  created_at: number
  updated_at: number
  fromReview?: boolean
}

// Define interface for task updates
interface TaskUpdate {
  title?: string
  description?: string
  effort?: 'low' | 'medium' | 'high'
  parent_task_id?: string
  fromReview?: boolean
}

// Define History Entry type for database operations
export interface HistoryEntry {
  id?: number
  timestamp: number
  role: 'user' | 'model' | 'tool_call' | 'tool_response'
  content: string
  feature_id: string
  task_id?: string
  action?: string
  details?: string
}

class DatabaseService {
  private db: sqlite3.Database | null = null
  private dbPath: string

  constructor(dbPath: string = SQLITE_DB_PATH) {
    this.dbPath = dbPath
    try {
      this.ensureDatabaseDirectory()
    } catch (error: any) {
      console.error(
        `[DatabaseService] CRITICAL: Failed to ensure database directory exists at ${path.dirname(
          this.dbPath
        )}: ${error.message}`
      )
    }
  }

  private ensureDatabaseDirectory(): void {
    const dbDir = path.dirname(this.dbPath)
    if (!fs.existsSync(dbDir)) {
      console.log(`[DatabaseService] Creating database directory: ${dbDir}`)
      fs.mkdirSync(dbDir, { recursive: true })
    }
  }

  async connect(): Promise<void> {
    if (this.db) {
      logger.debug('[DatabaseService] Already connected.')
      return Promise.resolve()
    }
    logger.debug(`[DatabaseService] Connecting to database at: ${this.dbPath}`)
    return new Promise((resolve, reject) => {
      const verboseDb = new (sqlite3.verbose().Database)(this.dbPath, (err) => {
        if (err) {
          logger.error(`Error connecting to SQLite database: ${err.message}`, {
            stack: err.stack,
          })
          reject(
            new Error(`Error connecting to SQLite database: ${err.message}`)
          )
          return
        }
        this.db = verboseDb
        logger.debug('[DatabaseService] Database connection successful.')
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    logger.debug('[DatabaseService] Attempting to close database connection.')
    return new Promise((resolve, reject) => {
      if (!this.db) {
        logger.debug('[DatabaseService] No active connection to close.')
        resolve()
        return
      }
      this.db.close((err) => {
        if (err) {
          logger.error(`Error closing SQLite database: ${err.message}`, {
            stack: err.stack,
          })
          reject(new Error(`Error closing SQLite database: ${err.message}`))
          return
        }
        this.db = null
        logger.debug(
          '[DatabaseService] Database connection closed successfully.'
        )
        resolve()
      })
    })
  }

  public async runAsync(
    sql: string,
    params: any[] = []
  ): Promise<sqlite3.RunResult> {
    if (!this.db) {
      logger.error(
        '[DatabaseService] runAsync called but database is not connected.'
      )
      throw new Error('Database is not connected')
    }
    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, function (err) {
        if (err) {
          logger.error(
            `Error executing SQL: ${sql} - Params: ${JSON.stringify(
              params
            )} - Error: ${err.message}`,
            { stack: err.stack }
          )
          reject(new Error(`Error executing SQL: ${err.message}`))
        } else {
          resolve(this)
        }
      })
    })
  }

  private async runSchemaFromFile(): Promise<void> {
    const schemaPath = path.join(__dirname, '..', 'config', 'schema.sql')
    logger.info(`Attempting to run schema from: ${schemaPath}`)
    if (!fs.existsSync(schemaPath)) {
      logger.error(`Schema file not found at ${schemaPath}`)
      throw new Error(`Schema file not found at ${schemaPath}`)
    }
    logger.info(`Schema file found at ${schemaPath}`)
    const schema = fs.readFileSync(schemaPath, 'utf8')
    const statements = schema
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
    logger.info(`Found ${statements.length} SQL statements in schema file.`)
    if (!this.db) {
      logger.error('Database is not connected in runSchemaFromFile.')
      throw new Error('Database is not connected')
    }
    try {
      logger.info('Starting transaction for schema execution.')
      await this.runAsync('BEGIN TRANSACTION;')
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i]
        logger.debug(
          `Executing schema statement #${i + 1}: ${statement.substring(
            0,
            60
          )}...`
        )
        await this.runAsync(statement)
        logger.debug(`Successfully executed statement #${i + 1}`)
      }
      logger.info('Committing transaction for schema execution.')
      await this.runAsync('COMMIT;')
      logger.info('Schema execution committed successfully.')
    } catch (error: any) {
      logger.error(
        `Error during schema execution: ${error.message}. Rolling back transaction.`,
        { stack: error.stack }
      )
      try {
        await this.runAsync('ROLLBACK;')
        logger.info('Transaction rolled back successfully.')
      } catch (rollbackError: any) {
        logger.error(`Failed to rollback transaction: ${rollbackError.message}`)
      }
      throw new Error(`Schema execution failed: ${error.message}`)
    }
  }

  async tableExists(tableName: string): Promise<boolean> {
    if (!this.db) {
      logger.error(
        '[DatabaseService] tableExists called but database is not connected.'
      )
      throw new Error('Database is not connected')
    }
    return new Promise((resolve, reject) => {
      this.db!.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [tableName],
        (err, row) => {
          if (err) {
            logger.error(
              `Error checking if table ${tableName} exists: ${err.message}`
            )
            reject(err)
          } else {
            resolve(!!row)
          }
        }
      )
    })
  }

  async initializeDatabase(): Promise<void> {
    if (!this.db) {
      logger.info(
        '[DatabaseService] Connecting DB within initializeDatabase...'
      )
      await this.connect()
    } else {
      logger.debug('[DatabaseService] DB already connected for initialization.')
    }
    try {
      logger.info('[DatabaseService] Checking if tables exist...')
      const tablesExist = await this.tableExists('tasks')
      logger.info(
        `[DatabaseService] 'tasks' table exists check returned: ${tablesExist}`
      )
      if (!tablesExist) {
        logger.info(
          '[DatabaseService] Initializing database schema as tables do not exist...'
        )
        await this.runSchemaFromFile()
        logger.info(
          '[DatabaseService] Database schema initialization complete.'
        )
      } else {
        logger.info(
          '[DatabaseService] Database tables already exist. Skipping schema initialization.'
        )
      }
    } catch (error: any) {
      logger.error(`Error during database initialization: ${error.message}`, {
        stack: error.stack,
      })
      console.error('Error initializing database:', error)
      throw error
    }
  }

  async runMigrations(): Promise<void> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      // Run schema first to create tables if they don't exist
      await this.runSchemaFromFile()

      // Run migrations to update existing tables
      await this.runMigrationsFromFile()
    } catch (error) {
      console.error('Error running migrations:', error)
      throw error
    }
  }

  private async runMigrationsFromFile(): Promise<void> {
    // Use __dirname to reliably locate the file relative to the compiled JS file
    const migrationsPath = path.join(
      __dirname,
      '..',
      'config',
      'migrations.sql'
    )
    console.log(
      `[DB Service] Attempting to load migrations from: ${migrationsPath}`
    ) // Log path

    if (!fs.existsSync(migrationsPath)) {
      console.log(
        `[DB Service] Migrations file not found at ${migrationsPath}, skipping migrations.` // Adjusted log level
      )
      return
    }
    console.log(
      `[DB Service] Migrations file found at ${migrationsPath}. Reading...`
    ) // Log if found

    const migrations = fs.readFileSync(migrationsPath, 'utf8')
    const statements = migrations
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)

    console.log(
      `[DB Service] Executing ${statements.length} statements from migrations.sql...`
    ) // Log count
    for (const statement of statements) {
      try {
        console.log(
          `[DB Service] Executing migration statement: ${statement.substring(
            0,
            100
          )}...`
        ) // Log statement (truncated)
        await this.runAsync(statement)
      } catch (error: any) {
        // Only ignore the error if it's specifically about a duplicate column
        if (error?.message?.includes('duplicate column name')) {
          console.log(
            `[DB Service] Migration statement likely already applied (duplicate column): ${statement}` // Adjusted log
          )
        } else {
          // Re-throw any other error during migration
          console.error(
            `[DB Service] Migration statement failed: ${statement}`,
            error
          ) // Adjusted log
          throw error
        }
      }
    }
    console.log(`[DB Service] Finished executing migration statements.`) // Log completion
  }

  async get(sql: string, params: any[] = []): Promise<any> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    return new Promise((resolve, reject) => {
      this.db!.get(sql, params, (err, row) => {
        if (err) {
          reject(`Error executing SQL: ${err.message}`)
          return
        }
        resolve(row)
      })
    })
  }

  async all(sql: string, params: any[] = []): Promise<any[]> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    return new Promise((resolve, reject) => {
      this.db!.all(sql, params, (err, rows) => {
        if (err) {
          reject(`Error executing SQL: ${err.message}`)
          return
        }
        resolve(rows)
      })
    })
  }

  async getTasksByFeatureId(featureId: string): Promise<Task[]> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      const rows = await this.all(
        `SELECT 
          id, title, description, status, 
          completed, effort, feature_id, parent_task_id,
          created_at, updated_at, from_review
        FROM tasks 
        WHERE feature_id = ?
        ORDER BY created_at ASC`,
        [featureId]
      )

      return rows.map((row) => ({
        ...row,
        completed: Boolean(row.completed),
        fromReview: Boolean(row.from_review),
      }))
    } catch (error) {
      console.error(`Error fetching tasks for feature ${featureId}:`, error)
      throw error
    }
  }

  async getTaskById(taskId: string): Promise<Task | null> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      const row = await this.get(
        `SELECT 
          id, title, description, status, 
          completed, effort, feature_id, parent_task_id,
          created_at, updated_at, from_review
        FROM tasks 
        WHERE id = ?`,
        [taskId]
      )

      if (!row) {
        return null
      }

      return {
        ...row,
        completed: Boolean(row.completed),
        fromReview: Boolean(row.from_review),
      }
    } catch (error) {
      console.error(`Error fetching task ${taskId}:`, error)
      throw error
    }
  }

  async addTask(task: Task): Promise<string> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    const now = Math.floor(Date.now() / 1000)
    const timestamp = task.created_at || now

    try {
      await this.runAsync(
        `INSERT INTO tasks (
          id, title, description, status, 
          completed, effort, feature_id, parent_task_id,
          created_at, updated_at, from_review
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.title || null,
          task.description || null,
          task.status,
          task.completed ? 1 : 0,
          task.effort || null,
          task.feature_id || null,
          task.parent_task_id || null,
          timestamp,
          task.updated_at || timestamp,
          task.fromReview ? 1 : 0,
        ]
      )

      return task.id
    } catch (error) {
      console.error('Error adding task:', error)
      throw error
    }
  }

  async updateTaskStatus(
    taskId: string,
    status: 'pending' | 'in_progress' | 'completed' | 'decomposed',
    completed?: boolean
  ): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    const now = Math.floor(Date.now() / 1000)

    try {
      let result

      if (completed !== undefined) {
        result = await this.runAsync(
          `UPDATE tasks 
           SET status = ?, completed = ?, updated_at = ? 
           WHERE id = ?`,
          [status, completed ? 1 : 0, now, taskId]
        )
      } else {
        result = await this.runAsync(
          `UPDATE tasks 
           SET status = ?, updated_at = ? 
           WHERE id = ?`,
          [status, now, taskId]
        )
      }

      return result.changes > 0
    } catch (error) {
      console.error(`Error updating status for task ${taskId}:`, error)
      throw error
    }
  }

  async updateTaskDetails(
    taskId: string,
    updates: TaskUpdate
  ): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    const now = Math.floor(Date.now() / 1000)

    try {
      const task = await this.getTaskById(taskId)

      if (!task) {
        return false
      }

      const updatedTask = {
        ...task,
        title: updates.title ?? task.title,
        description: updates.description ?? task.description,
        effort: updates.effort ?? task.effort,
        parent_task_id: updates.parent_task_id ?? task.parent_task_id,
        fromReview:
          updates.fromReview !== undefined
            ? updates.fromReview
            : task.fromReview,
        updated_at: now,
      }

      const result = await this.runAsync(
        `UPDATE tasks 
         SET title = ?, description = ?, effort = ?, parent_task_id = ?, updated_at = ?, from_review = ? 
         WHERE id = ?`,
        [
          updatedTask.title || null,
          updatedTask.description || null,
          updatedTask.effort || null,
          updatedTask.parent_task_id || null,
          updatedTask.updated_at,
          updatedTask.fromReview ? 1 : 0,
          taskId,
        ]
      )

      return result.changes > 0
    } catch (error) {
      console.error(`Error updating details for task ${taskId}:`, error)
      throw error
    }
  }

  async deleteTask(taskId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      // Begin transaction
      await this.runAsync('BEGIN TRANSACTION')

      try {
        // Delete any task relationships first
        await this.runAsync(
          'DELETE FROM task_relationships WHERE parent_id = ? OR child_id = ?',
          [taskId, taskId]
        )

        // Finally delete the task
        const result = await this.runAsync('DELETE FROM tasks WHERE id = ?', [
          taskId,
        ])

        // Commit transaction
        await this.runAsync('COMMIT')

        return result.changes > 0
      } catch (error) {
        // Rollback in case of error
        await this.runAsync('ROLLBACK')
        throw error
      }
    } catch (error) {
      console.error(`Error deleting task ${taskId}:`, error)
      throw error
    }
  }

  // History Entry Operations

  async getHistoryByFeatureId(
    featureId: string,
    limit: number = 100
  ): Promise<HistoryEntry[]> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      const rows = await this.all(
        `SELECT 
          id, timestamp, role, content, feature_id, 
          task_id, action, details
        FROM history_entries 
        WHERE feature_id = ?
        ORDER BY timestamp DESC
        LIMIT ?`,
        [featureId, limit]
      )

      return rows.map((row) => ({
        ...row,
        content:
          typeof row.content === 'string'
            ? JSON.parse(row.content)
            : row.content,
      }))
    } catch (error) {
      console.error(`Error fetching history for feature ${featureId}:`, error)
      throw error
    }
  }

  async addHistoryEntry(entry: HistoryEntry): Promise<number> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    const now = Math.floor(Date.now() / 1000)
    const timestamp = entry.timestamp || now
    const content =
      typeof entry.content === 'object'
        ? JSON.stringify(entry.content)
        : entry.content

    try {
      const result = await this.runAsync(
        `INSERT INTO history_entries (
          timestamp, role, content, feature_id,
          task_id, action, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          timestamp,
          entry.role,
          content,
          entry.feature_id,
          entry.task_id || null,
          entry.action || null,
          entry.details || null,
        ]
      )

      return result.lastID
    } catch (error) {
      console.error('Error adding history entry:', error)
      throw error
    }
  }

  async deleteHistoryByFeatureId(featureId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      const result = await this.runAsync(
        'DELETE FROM history_entries WHERE feature_id = ?',
        [featureId]
      )

      return result.changes > 0
    } catch (error) {
      console.error(`Error deleting history for feature ${featureId}:`, error)
      throw error
    }
  }

  // Feature Management

  /**
   * Creates a new feature in the database
   * @param id The feature ID
   * @param description The feature description
   * @param projectPath The project path for the feature
   * @returns The created feature
   */
  async createFeature(
    id: string,
    description: string,
    projectPath: string
  ): Promise<{ id: string; description: string; project_path: string }> {
    try {
      const now = Math.floor(Date.now() / 1000)

      await this.runAsync(
        `INSERT INTO features (id, description, project_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, description, projectPath, now, now]
      )

      return { id, description, project_path: projectPath }
    } catch (error) {
      console.error(`Error creating feature:`, error)
      throw error
    }
  }

  /**
   * Gets a feature by ID
   * @param featureId The feature ID
   * @returns The feature or null if not found
   */
  async getFeatureById(featureId: string): Promise<{
    id: string
    description: string
    project_path: string | null
    status: string
  } | null> {
    try {
      const feature = await this.get(
        `SELECT id, description, project_path, status
         FROM features
         WHERE id = ?`,
        [featureId]
      )

      return feature || null
    } catch (error) {
      console.error(`Error fetching feature ${featureId}:`, error)
      return null
    }
  }
}

export const databaseService = new DatabaseService()
export default DatabaseService
