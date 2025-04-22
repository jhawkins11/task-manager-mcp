-- Tasks Table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'decomposed')),
  completed INTEGER NOT NULL DEFAULT 0, -- SQLite uses INTEGER for boolean (0=false, 1=true)
  effort TEXT CHECK (effort IN ('low', 'medium', 'high')),
  feature_id TEXT,
  parent_task_id TEXT,
  created_at INTEGER NOT NULL, -- Unix timestamp
  updated_at INTEGER NOT NULL, -- Unix timestamp
  from_review INTEGER DEFAULT 0, -- Track if task was generated from a review
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- History Entries Table
CREATE TABLE IF NOT EXISTS history_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL, -- Unix timestamp
  role TEXT NOT NULL CHECK (role IN ('user', 'model', 'tool_call', 'tool_response')),
  content TEXT NOT NULL,
  feature_id TEXT NOT NULL
);

-- Features Table
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  created_at INTEGER NOT NULL, -- Unix timestamp
  updated_at INTEGER NOT NULL -- Unix timestamp
);

-- Task Relationships Table
CREATE TABLE IF NOT EXISTS task_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (child_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (parent_id, child_id)
);

-- Planning States Table
CREATE TABLE IF NOT EXISTS planning_states (
  question_id TEXT PRIMARY KEY, -- UUID as the primary key
  feature_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  partial_response TEXT NOT NULL,
  planning_type TEXT NOT NULL CHECK (planning_type IN ('feature_planning', 'plan_adjustment')),
  created_at INTEGER NOT NULL, -- Unix timestamp
  FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_feature_id ON tasks(feature_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_history_entries_feature_id ON history_entries(feature_id);
CREATE INDEX IF NOT EXISTS idx_task_relationships_parent_id ON task_relationships(parent_id);
CREATE INDEX IF NOT EXISTS idx_task_relationships_child_id ON task_relationships(child_id);
CREATE INDEX IF NOT EXISTS idx_planning_states_feature_id ON planning_states(feature_id); 