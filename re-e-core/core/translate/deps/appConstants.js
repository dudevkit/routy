// deps shim — extracted constants from upstream config/appConstants.js
export const CLAUDE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_TOOL_SUFFIX = "_ide";

export const CC_DEFAULT_TOOLS = new Set([
  "Task",
  "TaskOutput",
  "TaskStop",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
]);
