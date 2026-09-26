/** Only these workspace tools may be reached from local HTML artifacts. */
export interface ArtifactMcpCall {
  taskId: string
  path: string
  name: string
  arguments: Record<string, unknown>
  contentHash: string
  consented: boolean
  approved: boolean
}

export const ARTIFACT_READ_TOOLS = [
  'workflow_list', 'workflow_get', 'workflow_execution_list',
  'workflow_execution_get_steps', 'table_list', 'table_schema',
  'table_query', 'table_sql', 'report_schema', 'report_schema_detail',
  'report_query', 'datastore_list', 'datastore_query'
] as const
export const ARTIFACT_WRITE_TOOLS = ['workflow_execute'] as const

export function isArtifactWriteTool(name: string): boolean {
  return name === 'workflow_execute' || /^wf_[a-z0-9_]+$/.test(name)
}

export function isArtifactCallableTool(name: string): boolean {
  return (ARTIFACT_READ_TOOLS as readonly string[]).includes(name) || isArtifactWriteTool(name)
}

export function artifactToolsFromHtml(html: string): string[] {
  const match = /<script\b(?=[^>]*\bid=["']mcp-app-manifest["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)
  if (!match || match[1].length > 8192) return []
  try {
    const manifest = JSON.parse(match[1]) as { tools?: unknown }
    if (!Array.isArray(manifest.tools) || manifest.tools.length > 100) return []
    return manifest.tools.filter((tool): tool is string =>
      typeof tool === 'string' && (/^[a-z][a-z0-9_]*$/.test(tool) || /^wf_[a-z0-9_]+\*$/.test(tool)))
  } catch { return [] }
}

export function artifactManifestAllows(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => pattern === name ||
    (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))))
}

/** Handshake that binds the tool channel to ONE document. */
export const ARTIFACT_BRIDGE_HANDSHAKE = 'workflo-artifact-bridge/1'

/**
 * MCP Apps view transport for the sandboxed frame. It runs before any artifact
 * markup, makes a MessageChannel and hands one end to the host at once. All
 * requests and replies use that port, which dies with this document, so a page
 * the artifact navigates to cannot use the channel.
 */
export const ARTIFACT_MCP_SHIM = `<script>(function(){
  var channel=new MessageChannel(),port=channel.port1,next=0,pending={};
  parent.postMessage({type:'${ARTIFACT_BRIDGE_HANDSHAKE}'},'*',[channel.port2]);
  function send(method,params){return new Promise(function(resolve,reject){
    var id='workflo-'+(++next);pending[id]={resolve:resolve,reject:reject};
    port.postMessage({jsonrpc:'2.0',id:id,method:method,params:params});
  });}
  port.onmessage=function(event){
    var message=event.data;if(!message||message.jsonrpc!=='2.0')return;
    var entry=pending[message.id];if(!entry)return;delete pending[message.id];
    if(message.error)entry.reject(new Error(message.error.message||'Tool call failed'));
    else entry.resolve(message.result);
  };
  var ready;
  window.workflo={callTool:function(name,args){
    if(!ready)ready=send('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'workflo-artifact',version:'1.0.0'},appCapabilities:{}}).then(function(){
      port.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
    });
    return ready.then(function(){return send('tools/call',{name:name,arguments:args||{}});});
  }};
})();</script>`
