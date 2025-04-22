-- Add from_review column to tasks table if it doesn't exist
ALTER TABLE tasks ADD COLUMN from_review INTEGER DEFAULT 0; 