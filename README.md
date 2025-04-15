# Task Manager MCP

A powerful task management and breakdown system powered by AI. This tool helps break down complex features into manageable tasks, assign complexity ratings, and provides code reviews.

## Features

- Feature planning with AI-assisted breakdown
- Automatic complexity analysis for tasks
- Complex task decomposition into subtasks
- Code review capabilities
- Command-line interface via Model Context Protocol (MCP)

## Setup

### Prerequisites

- Node.js (v14+)
- npm or yarn
- Git (for code review functionality)

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file with your API keys (see Configuration section)
4. Build the project:
   ```
   npm run build
   ```
5. Run the task manager:
   ```
   npm start
   ```

## Configuration

The task manager supports two AI backends:

### OpenRouter (Recommended)

OpenRouter provides access to multiple powerful AI models including Google's Gemini models.

Required environment variables:

- `OPENROUTER_API_KEY`: Your OpenRouter API key
- `OPENROUTER_MODEL`: (Optional) The model to use (defaults to `google/gemini-2.5-pro-exp-03-25:free`)

### Google AI (Alternative)

You can also use Google's AI directly.

Required environment variables:

- `GEMINI_API_KEY`: Your Google AI API key
- `GEMINI_MODEL`: (Optional) The model to use (defaults to `gemini-1.5-flash`)

Example `.env` file:

```
OPENROUTER_API_KEY=sk-or-v1-your-api-key
OPENROUTER_MODEL=google/gemini-2.5-pro-exp-03-25:free
# Fallback to Google API if needed
# GEMINI_API_KEY=your-gemini-api-key
# GEMINI_MODEL=gemini-1.5-flash
```

## Usage

The task manager operates through MCP commands:

- `mcp_plan_feature`: Create a breakdown plan for a new feature
- `mcp_get_next_task`: Get the next pending task from the plan
- `mcp_mark_task_complete`: Mark a task as completed
- `mcp_review_changes`: Review code changes using AI

## License

This project is licensed under the MIT License.
