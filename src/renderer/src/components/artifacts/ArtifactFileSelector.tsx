export function ArtifactFileSelector({ files, path, onSelect }: { files: string[]; path?: string; onSelect: (path: string) => void }) {
  if (files.length < 2) return null
  const segments = files[0].split('/')
  segments.pop()
  while (segments.length && !files.every((file) => file.startsWith(`${segments.join('/')}/`))) segments.pop()
  const prefixLength = segments.length ? segments.join('/').length + 1 : 0
  return (
    <label className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
      File
      <select aria-label="Artifact file" value={path} onChange={(event) => onSelect(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-foreground">
        {files.map((file) => <option key={file} value={file}>{file.slice(prefixLength)}</option>)}
      </select>
    </label>
  )
}
