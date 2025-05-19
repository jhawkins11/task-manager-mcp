-- Add from_review column to tasks table if it doesn't exist
ALTER TABLE tasks ADD COLUMN from_review INTEGER DEFAULT 0;

-- Add task_id column to history_entries table if it doesn't exist
ALTER TABLE history_entries ADD COLUMN task_id TEXT;

-- Add action and details columns to history_entries table if they don't exist
ALTER TABLE history_entries ADD COLUMN action TEXT;
ALTER TABLE history_entries ADD COLUMN details TEXT; 

-- Add project_path column to features table if it doesn't exist
ALTER TABLE features ADD COLUMN project_path TEXT; 