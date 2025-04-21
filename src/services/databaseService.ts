import sqlite3 from 'sqlite3'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import { SQLITE_DB_PATH } from '../config'

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
}

// Define interface for task updates
interface TaskUpdate {
  title?: string
  description?: string
  effort?: 'low' | 'medium' | 'high'
  parent_task_id?: string
}

// Define History Entry type for database operations
interface HistoryEntry {
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
    this.ensureDatabaseDirectory()
  }

  private ensureDatabaseDirectory(): void {
    const dbDir = path.dirname(this.dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(`Error connecting to SQLite database: ${err.message}`)
          return
        }
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve()
        return
      }

      this.db.close((err) => {
        if (err) {
          reject(`Error closing SQLite database: ${err.message}`)
          return
        }
        this.db = null
        resolve()
      })
    })
  }

  async runMigrations(): Promise<void> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      await this.runSchemaFromFile()
    } catch (error) {
      console.error('Error running migrations:', error)
      throw error
    }
  }

  private async runSchemaFromFile(): Promise<void> {
    const schemaPath = path.join(process.cwd(), 'src', 'config', 'schema.sql')

    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found at ${schemaPath}`)
    }

    const schema = fs.readFileSync(schemaPath, 'utf8')
    const statements = schema
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)

    for (const statement of statements) {
      await this.run(`${statement};`)
    }
  }

  async run(sql: string, params: any[] = []): Promise<sqlite3.RunResult> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, function (err) {
        if (err) {
          reject(`Error executing SQL: ${err.message}`)
          return
        }
        resolve(this)
      })
    })
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

  async tableExists(tableName: string): Promise<boolean> {
    try {
      const result = await this.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [tableName]
      )
      return !!result
    } catch (error) {
      console.error(`Error checking if table ${tableName} exists:`, error)
      return false
    }
  }

  async initializeDatabase(): Promise<void> {
    try {
      await this.connect()
      const tablesExist = await this.tableExists('tasks')

      if (!tablesExist) {
        console.log('Initializing database schema...')
        await this.runMigrations()
      }
    } catch (error) {
      console.error('Error initializing database:', error)
      throw error
    }
  }

  // Task CRUD Operations

  async getTasksByFeatureId(featureId: string): Promise<Task[]> {
    if (!this.db) {
      throw new Error('Database is not connected')
    }

    try {
      const rows = await this.all(
        `SELECT 
          id, title, description, status, 
          completed, effort, feature_id, parent_task_id,
          created_at, updated_at
        FROM tasks 
        WHERE feature_id = ?
        ORDER BY created_at ASC`,
        [featureId]
      )

      return rows.map((row) => ({
        ...row,
        completed: Boolean(row.completed),
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
          created_at, updated_at
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
      await this.run(
        `INSERT INTO tasks (
          id, title, description, status, 
          completed, effort, feature_id, parent_task_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        result = await this.run(
          `UPDATE tasks 
           SET status = ?, completed = ?, updated_at = ? 
           WHERE id = ?`,
          [status, completed ? 1 : 0, now, taskId]
        )
      } else {
        result = await this.run(
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
        updated_at: now,
      }

      const result = await this.run(
        `UPDATE tasks 
         SET title = ?, description = ?, effort = ?, parent_task_id = ?, updated_at = ? 
         WHERE id = ?`,
        [
          updatedTask.title || null,
          updatedTask.description || null,
          updatedTask.effort || null,
          updatedTask.parent_task_id || null,
          updatedTask.updated_at,
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
      await this.run('BEGIN TRANSACTION')

      try {
        // Delete any task relationships first
        await this.run(
          'DELETE FROM task_relationships WHERE parent_id = ? OR child_id = ?',
          [taskId, taskId]
        )

        // Delete any task history entries
        await this.run('DELETE FROM task_history WHERE task_id = ?', [taskId])

        // Finally delete the task
        const result = await this.run('DELETE FROM tasks WHERE id = ?', [
          taskId,
        ])

        // Commit transaction
        await this.run('COMMIT')

        return result.changes > 0
      } catch (error) {
        // Rollback in case of error
        await this.run('ROLLBACK')
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
      const result = await this.run(
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
      const result = await this.run(
        'DELETE FROM history_entries WHERE feature_id = ?',
        [featureId]
      )

      return result.changes > 0
    } catch (error) {
      console.error(`Error deleting history for feature ${featureId}:`, error)
      throw error
    }
  }
}

export const databaseService = new DatabaseService()
export default DatabaseService
