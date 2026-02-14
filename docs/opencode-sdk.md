SDK
Type-safe JS client for opencode server.

The opencode JS/TS SDK provides a type-safe client for interacting with the server. Use it to build integrations and control opencode programmatically.

Learn more about how the server works. For examples, check out the projects built by the community.

Install
Install the SDK from npm:

Terminal window
npm install @opencode-ai/sdk

Create client
Create an instance of opencode:

import { createOpencode } from "@opencode-ai/sdk"

const { client } = await createOpencode()

This starts both a server and a client

Options
Option	Type	Description	Default
hostname	string	Server hostname	127.0.0.1
port	number	Server port	4096
signal	AbortSignal	Abort signal for cancellation	undefined
timeout	number	Timeout in ms for server start	5000
config	Config	Configuration object	{}
Config
You can pass a configuration object to customize behavior. The instance still picks up your opencode.json, but you can override or add configuration inline:

import { createOpencode } from "@opencode-ai/sdk"

const opencode = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: {
    model: "anthropic/claude-3-5-sonnet-20241022",
  },
})

console.log(`Server running at ${opencode.server.url}`)

opencode.server.close()

Client only
If you already have a running instance of opencode, you can create a client instance to connect to it:

import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
})

Options
Option	Type	Description	Default
baseUrl	string	URL of the server	http://localhost:4096
fetch	function	Custom fetch implementation	globalThis.fetch
parseAs	string	Response parsing method	auto
responseStyle	string	Return style: data or fields	fields
throwOnError	boolean	Throw errors instead of return	false
Types
The SDK includes TypeScript definitions for all API types. Import them directly:

import type { Session, Message, Part } from "@opencode-ai/sdk"

All types are generated from the server’s OpenAPI specification and available in the types file.

Errors
The SDK can throw errors that you can catch and handle:

try {
  await client.session.get({ path: { id: "invalid-id" } })
} catch (error) {
  console.error("Failed to get session:", (error as Error).message)
}

Structured Output
You can request structured JSON output from the model by specifying an format with a JSON schema. The model will use a StructuredOutput tool to return validated JSON matching your schema.

Basic Usage
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Research Anthropic and provide company info" }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          company: { type: "string", description: "Company name" },
          founded: { type: "number", description: "Year founded" },
          products: {
            type: "array",
            items: { type: "string" },
            description: "Main products",
          },
        },
        required: ["company", "founded"],
      },
    },
  },
})

// Access the structured output
console.log(result.data.info.structured_output)
// { company: "Anthropic", founded: 2021, products: ["Claude", "Claude API"] }

Output Format Types
Type	Description
text	Default. Standard text response (no structured output)
json_schema	Returns validated JSON matching the provided schema
JSON Schema Format
When using type: 'json_schema', provide:

Field	Type	Description
type	'json_schema'	Required. Specifies JSON schema mode
schema	object	Required. JSON Schema object defining the output structure
retryCount	number	Optional. Number of validation retries (default: 2)
Error Handling
If the model fails to produce valid structured output after all retries, the response will include a StructuredOutputError:

if (result.data.info.error?.name === "StructuredOutputError") {
  console.error("Failed to produce structured output:", result.data.info.error.message)
  console.error("Attempts:", result.data.info.error.retries)
}

Best Practices
Provide clear descriptions in your schema properties to help the model understand what data to extract
Use required to specify which fields must be present
Keep schemas focused - complex nested schemas may be harder for the model to fill correctly
Set appropriate retryCount - increase for complex schemas, decrease for simple ones
APIs
The SDK exposes all server APIs through a type-safe client.

Global
Method	Description	Response
global.health()	Check server health and version	{ healthy: true, version: string }
Examples
const health = await client.global.health()
console.log(health.data.version)

App
Method	Description	Response
app.log()	Write a log entry	boolean
app.agents()	List all available agents	Agent[]
Examples
// Write a log entry
await client.app.log({
  body: {
    service: "my-app",
    level: "info",
    message: "Operation completed",
  },
})

// List available agents
const agents = await client.app.agents()

Project
Method	Description	Response
project.list()	List all projects	Project[]
project.current()	Get current project	Project
Examples
// List all projects
const projects = await client.project.list()

// Get current project
const currentProject = await client.project.current()

Path
Method	Description	Response
path.get()	Get current path	Path
Examples
// Get current path information
const pathInfo = await client.path.get()

Config
Method	Description	Response
config.get()	Get config info	Config
config.providers()	List providers and default models	{ providers: Provider[], default: { [key: string]: string } }
Examples
const config = await client.config.get()

const { providers, default: defaults } = await client.config.providers()

Sessions
Method	Description	Notes
session.list()	List sessions	Returns Session[]
session.get({ path })	Get session	Returns Session
session.children({ path })	List child sessions	Returns Session[]
session.create({ body })	Create session	Returns Session
session.delete({ path })	Delete session	Returns boolean
session.update({ path, body })	Update session properties	Returns Session
session.init({ path, body })	Analyze app and create AGENTS.md	Returns boolean
session.abort({ path })	Abort a running session	Returns boolean
session.share({ path })	Share session	Returns Session
session.unshare({ path })	Unshare session	Returns Session
session.summarize({ path, body })	Summarize session	Returns boolean
session.messages({ path })	List messages in a session	Returns { info: Message, parts: Part[]}[]
session.message({ path })	Get message details	Returns { info: Message, parts: Part[]}
session.prompt({ path, body })	Send prompt message	body.noReply: true returns UserMessage (context only). Default returns AssistantMessage with AI response. Supports body.outputFormat for structured output
session.command({ path, body })	Send command to session	Returns { info: AssistantMessage, parts: Part[]}
session.shell({ path, body })	Run a shell command	Returns AssistantMessage
session.revert({ path, body })	Revert a message	Returns Session
session.unrevert({ path })	Restore reverted messages	Returns Session
postSessionByIdPermissionsByPermissionId({ path, body })	Respond to a permission request	Returns boolean
Examples
// Create and manage sessions
const session = await client.session.create({
  body: { title: "My session" },
})

const sessions = await client.session.list()

// Send a prompt message
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    parts: [{ type: "text", text: "Hello!" }],
  },
})

// Inject context without triggering AI response (useful for plugins)
await client.session.prompt({
  path: { id: session.id },
  body: {
    noReply: true,
    parts: [{ type: "text", text: "You are a helpful assistant." }],
  },
})

Files
Method	Description	Response
find.text({ query })	Search for text in files	Array of match objects with path, lines, line_number, absolute_offset, submatches
find.files({ query })	Find files and directories by name	string[] (paths)
find.symbols({ query })	Find workspace symbols	Symbol[]
file.read({ query })	Read a file	{ type: "raw" | "patch", content: string }
file.status({ query? })	Get status for tracked files	File[]
find.files supports a few optional query fields:

type: "file" or "directory"
directory: override the project root for the search
limit: max results (1–200)
Examples
// Search and read files
const textResults = await client.find.text({
  query: { pattern: "function.*opencode" },
})

const files = await client.find.files({
  query: { query: "*.ts", type: "file" },
})

const directories = await client.find.files({
  query: { query: "packages", type: "directory", limit: 20 },
})

const content = await client.file.read({
  query: { path: "src/index.ts" },
})

TUI
Method	Description	Response
tui.appendPrompt({ body })	Append text to the prompt	boolean
tui.openHelp()	Open the help dialog	boolean
tui.openSessions()	Open the session selector	boolean
tui.openThemes()	Open the theme selector	boolean
tui.openModels()	Open the model selector	boolean
tui.submitPrompt()	Submit the current prompt	boolean
tui.clearPrompt()	Clear the prompt	boolean
tui.executeCommand({ body })	Execute a command	boolean
tui.showToast({ body })	Show toast notification	boolean
Examples
// Control TUI interface
await client.tui.appendPrompt({
  body: { text: "Add this to prompt" },
})

await client.tui.showToast({
  body: { message: "Task completed", variant: "success" },
})

Auth
Method	Description	Response
auth.set({ ... })	Set authentication credentials	boolean
Examples
await client.auth.set({
  path: { id: "anthropic" },
  body: { type: "api", key: "your-api-key" },
})

Events
Method	Description	Response
event.subscribe()	Server-sent events stream	Server-sent events stream
Examples
// Listen to real-time events
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log("Event:", event.type, event.properties)
}

