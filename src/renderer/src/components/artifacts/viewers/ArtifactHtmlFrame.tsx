import { useLayoutEffect, useMemo, useRef } from 'react'
import { ARTIFACT_MCP_SHIM } from '@shared/artifact-mcp'

const HARDENING = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"><base href="about:blank"><script>window.open=function(){return null};document.addEventListener('click',function(event){var a=event.target.closest&&event.target.closest('a[href]');if(!a)return;var href=a.getAttribute('href');if(!href||href.charAt(0)==='#')return;event.preventDefault();window.parent.postMessage({type:'artifact:open-file',href:href},'*')},true);</script>${ARTIFACT_MCP_SHIM}`

/** Keep file navigation in the host. The frame cannot read local files or
 * navigate the app, and messages from other frames are ignored. */
export function ArtifactHtmlFrame({ html, title, onLinkClick, onMessage }: { html: string; title: string; onLinkClick?: (href: string) => boolean; onMessage?: (data: unknown, reply: (message: Record<string, unknown>) => void) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const srcDoc = useMemo(() => `${HARDENING}${html}`, [html])
  useLayoutEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'null' || !frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return
      if (event.data?.type === 'artifact:open-file' && typeof event.data.href === 'string') {
        onLinkClick?.(event.data.href)
      } else onMessage?.(event.data, (message) => frameRef.current?.contentWindow?.postMessage(message, '*'))
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [onLinkClick, onMessage])
  return <iframe ref={frameRef} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} className="h-full w-full border-0 bg-white" />
}
