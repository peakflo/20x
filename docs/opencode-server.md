Server
Interact with opencode server over HTTP.

The opencode serve command runs a headless HTTP server that exposes an OpenAPI endpoint that an opencode client can use.

Usage
Terminal window
opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]

Options
Flag	Description	Default
--port	Port to listen on	4096
--hostname	Hostname to listen on	127.0.0.1
--mdns	Enable mDNS discovery	false
--mdns-domain	Custom domain name for mDNS service	opencode.local
--cors	Additional browser origins to allow	[]
--cors can be passed multiple times:

Terminal window
opencode serve --cors http://localhost:5173 --cors https://app.example.com

Authentication
Set OPENCODE_SERVER_PASSWORD to protect the server with HTTP basic auth. The username defaults to opencode, or set OPENCODE_SERVER_USERNAME to override it. This applies to both opencode serve and opencode web.

Terminal window
OPENCODE_SERVER_PASSWORD=your-password opencode serve

How it works
When you run opencode it starts a TUI and a server. Where the TUI is the client that talks to the server. The server exposes an OpenAPI 3.1 spec endpoint. This endpoint is also used to generate an SDK.

Tip

Use the opencode server to interact with opencode programmatically.

This architecture lets opencode support multiple clients and allows you to interact with opencode programmatically.

You can run opencode serve to start a standalone server. If you have the opencode TUI running, opencode serve will start a new server.

Connect to an existing server
When you start the TUI it randomly assigns a port and hostname. You can instead pass in the --hostname and --port flags. Then use this to connect to its server.

The /tui endpoint can be used to drive the TUI through the server. For example, you can prefill or run a prompt. This setup is used by the OpenCode IDE plugins.

Spec
The server publishes an OpenAPI 3.1 spec that can be viewed at:

http://<hostname>:<port>/doc

For example, http://localhost:4096/doc. Use the spec to generate clients or inspect request and response types. Or view it in a Swagger explorer.

APIs
The opencode server exposes the following APIs.

Global
Method	Path	Description	Response
GET	/global/health	Get server health and version	{ healthy: true, version: string }
GET	/global/event	Get global events (SSE stream)	Event stream
Project
Method	Path	Description	Response
GET	/project	List all projects	Project[]
GET	/project/current	Get the current project	Project
Path & VCS
Method	Path	Description	Response
GET	/path	Get the current path	Path
GET	/vcs	Get VCS info for the current project	VcsInfo
Instance
Method	Path	Description	Response
POST	/instance/dispose	Dispose the current instance	boolean
Config
Method	Path	Description	Response
GET	/config	Get config info	Config
PATCH	/config	Update config	Config
GET	/config/providers	List providers and default models	{ providers: Provider[], default: { [key: string]: string } }
Provider
Method	Path	Description	Response
GET	/provider	List all providers	{ all: Provider[], default: {...}, connected: string[] }
GET	/provider/auth	Get provider authentication methods	{ [providerID: string]: ProviderAuthMethod[] }
POST	/provider/{id}/oauth/authorize	Authorize a provider using OAuth	ProviderAuthAuthorization
POST	/provider/{id}/oauth/callback	Handle OAuth callback for a provider	boolean
Sessions
Method	Path	Description	Notes
GET	/session	List all sessions	Returns Session[]
POST	/session	Create a new session	body: { parentID?, title? }, returns Session
GET	/session/status	Get session status for all sessions	Returns { [sessionID: string]: SessionStatus }
GET	/session/:id	Get session details	Returns Session
DELETE	/session/:id	Delete a session and all its data	Returns boolean
PATCH	/session/:id	Update session properties	body: { title? }, returns Session
GET	/session/:id/children	Get a session’s child sessions	Returns Session[]
GET	/session/:id/todo	Get the todo list for a session	Returns Todo[]
POST	/session/:id/init	Analyze app and create AGENTS.md	body: { messageID, providerID, modelID }, returns boolean
POST	/session/:id/fork	Fork an existing session at a message	body: { messageID? }, returns Session
POST	/session/:id/abort	Abort a running session	Returns boolean
POST	/session/:id/share	Share a session	Returns Session
DELETE	/session/:id/share	Unshare a session	Returns Session
GET	/session/:id/diff	Get the diff for this session	query: messageID?, returns FileDiff[]
POST	/session/:id/summarize	Summarize the session	body: { providerID, modelID }, returns boolean
POST	/session/:id/revert	Revert a message	body: { messageID, partID? }, returns boolean
POST	/session/:id/unrevert	Restore all reverted messages	Returns boolean
POST	/session/:id/permissions/:permissionID	Respond to a permission request	body: { response, remember? }, returns boolean
Messages
Method	Path	Description	Notes
GET	/session/:id/message	List messages in a session	query: limit?, returns { info: Message, parts: Part[]}[]
POST	/session/:id/message	Send a message and wait for response	body: { messageID?, model?, agent?, noReply?, system?, tools?, parts }, returns { info: Message, parts: Part[]}
GET	/session/:id/message/:messageID	Get message details	Returns { info: Message, parts: Part[]}
POST	/session/:id/prompt_async	Send a message asynchronously (no wait)	body: same as /session/:id/message, returns 204 No Content
POST	/session/:id/command	Execute a slash command	body: { messageID?, agent?, model?, command, arguments }, returns { info: Message, parts: Part[]}
POST	/session/:id/shell	Run a shell command	body: { agent, model?, command }, returns { info: Message, parts: Part[]}
Commands
Method	Path	Description	Response
GET	/command	List all commands	Command[]
Files
Method	Path	Description	Response
GET	/find?pattern=<pat>	Search for text in files	Array of match objects with path, lines, line_number, absolute_offset, submatches
GET	/find/file?query=<q>	Find files and directories by name	string[] (paths)
GET	/find/symbol?query=<q>	Find workspace symbols	Symbol[]
GET	/file?path=<path>	List files and directories	FileNode[]
GET	/file/content?path=<p>	Read a file	FileContent
GET	/file/status	Get status for tracked files	File[]
/find/file query parameters
query (required) — search string (fuzzy match)
type (optional) — limit results to "file" or "directory"
directory (optional) — override the project root for the search
limit (optional) — max results (1–200)
dirs (optional) — legacy flag ("false" returns only files)
Tools (Experimental)
Method	Path	Description	Response
GET	/experimental/tool/ids	List all tool IDs	ToolIDs
GET	/experimental/tool?provider=<p>&model=<m>	List tools with JSON schemas for a model	ToolList
LSP, Formatters & MCP
Method	Path	Description	Response
GET	/lsp	Get LSP server status	LSPStatus[]
GET	/formatter	Get formatter status	FormatterStatus[]
GET	/mcp	Get MCP server status	{ [name: string]: MCPStatus }
POST	/mcp	Add MCP server dynamically	body: { name, config }, returns MCP status object
Agents
Method	Path	Description	Response
GET	/agent	List all available agents	Agent[]
Logging
Method	Path	Description	Response
POST	/log	Write log entry. Body: { service, level, message, extra? }	boolean
TUI
Method	Path	Description	Response
POST	/tui/append-prompt	Append text to the prompt	boolean
POST	/tui/open-help	Open the help dialog	boolean
POST	/tui/open-sessions	Open the session selector	boolean
POST	/tui/open-themes	Open the theme selector	boolean
POST	/tui/open-models	Open the model selector	boolean
POST	/tui/submit-prompt	Submit the current prompt	boolean
POST	/tui/clear-prompt	Clear the prompt	boolean
POST	/tui/execute-command	Execute a command ({ command })	boolean
POST	/tui/show-toast	Show toast ({ title?, message, variant })	boolean
GET	/tui/control/next	Wait for the next control request	Control request object
POST	/tui/control/response	Respond to a control request ({ body })	boolean
Auth
Method	Path	Description	Response
PUT	/auth/:id	Set authentication credentials. Body must match provider schema	boolean
Events
Method	Path	Description	Response
GET	/event	Server-sent events stream. First event is server.connected, then bus events	Server-sent events stream
Docs
Method	Path	Description	Response
GET	/doc	OpenAPI 3.1 specification	HTML page with OpenAPI spec