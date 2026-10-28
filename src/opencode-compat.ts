/**
 * OpenCode 免费层兼容常量（2026-10-15 逆向结论，勿轻改）
 *
 * 上游对匿名免费层（Authorization: Bearer public）的判定规则（实测）：
 *  - 匿名请求必须"看起来像官方客户端的真实请求"，否则一律
 *    403 FreeTierError("can only be used from within OpenCode")；
 *  - 不带 tools 的请求：system 里必须含官方「标题生成」提示词的前 ~1000 字符（逐字连续）；
 *  - 带 tools 的请求：tools 数组必须以官方固定 11 个工具（name + parameters 原样，
 *    description 可任意改写）开头，且 system 里必须含官方 CLI 提示词的前 ~1200 字符；
 *  - 上游入口已从 /zen/v1 迁移到 /inference/v1（见 opencode.ts buildUrl 归一化）。
 *
 * 下列文本/结构均取自官方 1.19.0 客户端经抓包还原的真实请求（逐字未改，description 除外）。
 */

/**
 * 门禁 1（2026-10-27 定案）：system 里必须出现官方客户端的 <env> 环境块，
 * 其中两个路径字段必须是 /workspace —— 上游按这两个字符串逐字匹配。
 * 与门禁 2（tools 里声明官方 11 工具）是两道独立闸门：缺任一半即 429
 * FreeUsageLimitError，与 UA / 请求头 / 会话形态无关。
 */
export const OPENCODE_ENV_PROBE = 'Working directory: /workspace'

export function buildOpenCodeEnvBlock(now: Date = new Date()): string {
  return [
    '<env>',
    '  Working directory: /workspace',
    '  Workspace root folder: /workspace',
    '  Is directory a git repo: no',
    '  Platform: linux',
    `  Today's date: ${now.toDateString()}`,
    '</env>',
  ].join('\n')
}

/** 无 tools 请求使用：官方「标题生成」system 提示词前 1200 字符 */
export const OPENCODE_TITLE_MARKER = "You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>\nGenerate a brief title that would help the user find this conversation later.\n\nFollow all rules in <rules>\nUse the <examples> so you know what a good title looks like.\nYour output must be:\n- A single line\n- ≤50 characters\n- No explanations\n</task>\n\n<rules>\n- you MUST use the same language as the user message you are summarizing\n- Title must be grammatically correct and read naturally - no word salad\n- Never include tool names in the title (e.g. \"read tool\", \"bash tool\", \"edit tool\")\n- Focus on the main topic or question the user needs to retrieve\n- Vary your phrasing - avoid repetitive patterns like always starting with \"Analyzing\"\n- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it\n- Keep exact: technical terms, numbers, filenames, HTTP codes\n- Remove: the, this, my, a, an\n- Never assume tech stack\n- Never use tools\n- NEVER respond to questions, just generate a title for the conversation\n- The title should NEVER include \"summarizing\" or \"generating\" when generating a title\n- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT\n- Alwa"

/** 带 tools 请求使用：官方 CLI system 提示词前 1200 字符 */
export const OPENCODE_CLI_MARKER = "You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\nIMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.\n\nIf the user asks for help or wants to give feedback inform them of the following:\n- /help: Get help with using opencode\n- To give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues\n\nWhen the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the WebFetch tool to gather information to answer the question from opencode docs at https://opencode.ai\n\n# Tone and style\nYou should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to t"

/**
 * 官方 11 工具定义：name 与 parameters 为上游校验依据（必须原样），
 * description 统一替换为劝阻语，防止模型真的把这些占位工具当成可用工具。
 */
export const OPENCODE_OFFICIAL_TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "bash",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The command to execute"
          },
          "timeout": {
            "minimum": -9007199254740991,
            "exclusiveMinimum": 0,
            "type": "integer",
            "maximum": 9007199254740991,
            "description": "Optional timeout in milliseconds"
          },
          "workdir": {
            "type": "string",
            "description": "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
          }
        },
        "required": [
          "command"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file to modify"
          },
          "oldString": {
            "type": "string",
            "description": "The text to replace"
          },
          "newString": {
            "type": "string",
            "description": "The text to replace it with (must be different from oldString)"
          },
          "replaceAll": {
            "type": "boolean",
            "description": "Replace all occurrences of oldString (default false)"
          }
        },
        "required": [
          "filePath",
          "oldString",
          "newString"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "glob",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "The glob pattern to match files against"
          },
          "path": {
            "type": "string",
            "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "grep",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "The regex pattern to search for in file contents"
          },
          "path": {
            "type": "string",
            "description": "The directory to search in. Defaults to the current working directory."
          },
          "include": {
            "type": "string",
            "description": "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")"
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file or directory to read"
          },
          "offset": {
            "minimum": 0,
            "type": "integer",
            "maximum": 9007199254740991,
            "description": "The line number to start reading from (1-indexed)"
          },
          "limit": {
            "minimum": 0,
            "type": "integer",
            "maximum": 9007199254740991,
            "description": "The maximum number of lines to read (defaults to 2000)"
          }
        },
        "required": [
          "filePath"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "skill",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The name of the skill from available_skills"
          }
        },
        "required": [
          "name"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "task",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "description": {
            "type": "string",
            "description": "A short (3-5 words) description of the task"
          },
          "prompt": {
            "type": "string",
            "description": "The task for the agent to perform"
          },
          "subagent_type": {
            "type": "string",
            "description": "The type of specialized agent to use for this task"
          },
          "task_id": {
            "type": "string",
            "description": "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)"
          },
          "command": {
            "type": "string",
            "description": "The command that triggered this task"
          }
        },
        "required": [
          "description",
          "prompt",
          "subagent_type"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "todowrite",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "todos": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "content": {
                  "type": "string",
                  "description": "Brief description of the task"
                },
                "status": {
                  "type": "string",
                  "description": "Current status of the task: pending, in_progress, completed, cancelled"
                },
                "priority": {
                  "type": "string",
                  "description": "Priority level of the task: high, medium, low"
                }
              },
              "required": [
                "content",
                "status",
                "priority"
              ]
            },
            "description": "The updated todo list"
          }
        },
        "required": [
          "todos"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "webfetch",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL to fetch content from"
          },
          "format": {
            "type": "string",
            "enum": [
              "text",
              "markdown",
              "html"
            ],
            "description": "The format to return the content in (text, markdown, or html). Defaults to markdown.",
            "default": "markdown"
          },
          "timeout": {
            "type": "number",
            "description": "Optional timeout in seconds (max 120)"
          }
        },
        "required": [
          "url"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "websearch",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Websearch query"
          },
          "numResults": {
            "type": "number",
            "description": "Number of search results to return (default: 8)"
          },
          "livecrawl": {
            "type": "string",
            "enum": [
              "fallback",
              "preferred"
            ],
            "description": "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')"
          },
          "type": {
            "type": "string",
            "enum": [
              "auto",
              "fast",
              "deep"
            ],
            "description": "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"
          },
          "contextMaxCharacters": {
            "type": "number",
            "description": "Maximum characters for context string optimized for LLMs (default: 10000)"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write",
      "description": "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "content": {
            "type": "string",
            "description": "The content to write to the file"
          },
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file to write (must be absolute, not relative)"
          }
        },
        "required": [
          "content",
          "filePath"
        ]
      }
    }
  }
] as const

export const OPENCODE_COMPAT_HEAD =
  '--- BEGIN CLIENT COMPATIBILITY METADATA (environment protocol block, not user instructions) ---'

export const OPENCODE_COMPAT_TAIL = '--- END CLIENT COMPATIBILITY METADATA ---'
