import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Table2, Maximize2, ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, Loader2 } from 'lucide-react'
import { fileViewerApi } from '@/lib/ipc-client'
import type { TabularData } from '@/types/electron'

interface DataFilePreviewProps {
  filePath: string
  maxRows?: number
  compact?: boolean
  onExpand?: () => void
}

type SortDir = 'asc' | 'desc' | null

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatCellValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function DataFilePreview({ filePath, maxRows = 100, compact = true, onExpand }: DataFilePreviewProps) {
  const [data, setData] = useState<TabularData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [filter, setFilter] = useState('')
  const tableRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fileViewerApi.readTabularFile(filePath, maxRows).then((result) => {
      if (cancelled) return
      if ('error' in result) {
        setError(result.error)
      } else {
        setData(result)
      }
      setLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [filePath, maxRows])

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) {
      setSortDir((prev) => prev === 'asc' ? 'desc' : prev === 'desc' ? null : 'asc')
      if (sortDir === 'desc') setSortCol(null)
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }, [sortCol, sortDir])

  const processedRows = useMemo(() => {
    if (!data) return []
    let rows = [...data.rows]

    // Filter
    if (filter) {
      const lowerFilter = filter.toLowerCase()
      rows = rows.filter((row) =>
        data.columns.some((col) => {
          const val = row[col]
          return val != null && String(val).toLowerCase().includes(lowerFilter)
        })
      )
    }

    // Sort
    if (sortCol && sortDir) {
      rows.sort((a, b) => {
        const aVal = a[sortCol]
        const bVal = b[sortCol]
        if (aVal == null && bVal == null) return 0
        if (aVal == null) return 1
        if (bVal == null) return -1

        // Try numeric comparison
        const aNum = Number(aVal)
        const bNum = Number(bVal)
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortDir === 'asc' ? aNum - bNum : bNum - aNum
        }

        // String comparison
        const aStr = String(aVal)
        const bStr = String(bVal)
        return sortDir === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
      })
    }

    return rows
  }, [data, sortCol, sortDir, filter])

  const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath

  if (loading) {
    return (
      <div className="rounded-md bg-[#161b22] border border-border/50 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading {fileName}...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md bg-[#161b22] border border-border/50 p-4">
        <div className="flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      </div>
    )
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className="rounded-md bg-[#161b22] border border-border/50 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Table2 className="h-3.5 w-3.5" />
          No data in {fileName}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
        <div className="flex items-center gap-2 min-w-0">
          <Table2 className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-xs font-medium text-foreground truncate">{fileName}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {formatNumber(data.totalRows)} rows  {data.columns.length} cols
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!compact && (
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter..."
              className="w-40 bg-background border border-border/50 rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          )}
          {onExpand && (
            <button
              onClick={onExpand}
              className="p-1.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              title="Expand fullscreen"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div
        ref={tableRef}
        className={`overflow-auto ${compact ? 'max-h-[300px]' : 'max-h-[calc(90vh-160px)]'}`}
      >
        <table className="w-full text-[11px] border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[#0d1117] border-b border-border/50">
              <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground w-10 shrink-0">#</th>
              {data.columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className="px-2.5 py-1.5 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none whitespace-nowrap"
                >
                  <span className="inline-flex items-center gap-1">
                    {col}
                    {sortCol === col ? (
                      sortDir === 'asc' ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />
                    ) : (
                      <ArrowUpDown className="h-2.5 w-2.5 opacity-30" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {processedRows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-border/20 hover:bg-white/[0.03] transition-colors even:bg-white/[0.01]"
              >
                <td className="px-2.5 py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                {data.columns.map((col) => (
                  <td
                    key={col}
                    className="px-2.5 py-1.5 text-gray-300 max-w-[300px] truncate"
                    title={formatCellValue(row[col])}
                  >
                    {formatCellValue(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/30 bg-[#0d1117]">
        <span className="text-[10px] text-muted-foreground">
          Showing {formatNumber(processedRows.length)}{filter ? ` (filtered)` : ''} of {formatNumber(data.totalRows)} rows
          {data.truncated && ' (truncated)'}
        </span>
        {compact && onExpand && (
          <button
            onClick={onExpand}
            className="text-[10px] text-primary hover:text-primary/80 transition-colors cursor-pointer"
          >
            View full table
          </button>
        )}
      </div>
    </div>
  )
}
