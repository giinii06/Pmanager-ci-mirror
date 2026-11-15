import { useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react'
import type { FolderDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'

interface FolderTreeProps {
  libraryId: string
  folders: FolderDTO[]
}

export function FolderTree({ libraryId, folders }: FolderTreeProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { root, children } = useMemo(() => {
    const byParent = new Map<string | null, FolderDTO[]>()
    for (const folder of folders) {
      if (folder.libraryId !== libraryId) continue
      const list = byParent.get(folder.parentId) ?? []
      list.push(folder)
      byParent.set(folder.parentId, list)
    }
    const libraryRoot = folders.find(
      (folder) => folder.libraryId === libraryId && folder.parentId === null,
    )
    return { root: libraryRoot, children: byParent }
  }, [folders, libraryId])

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderFolder = (folder: FolderDTO, depth: number) => {
    const kids = children.get(folder.id) ?? []
    const isOpen = expanded.has(folder.id)
    const active = location.pathname === `/folders/${folder.id}`
    return (
      <div key={folder.id}>
        <div
          className={cn(
            'group flex h-8 items-center gap-1 rounded-md pr-1.5 transition-colors',
            active ? 'bg-white/[0.07] text-ink' : 'text-muted hover:bg-white/[0.04] hover:text-ink',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <button
            type="button"
            aria-label={isOpen ? '접기' : '펼치기'}
            onClick={() => toggle(folder.id)}
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition-transform hover:text-ink',
              kids.length === 0 && 'invisible',
              isOpen && 'rotate-90',
            )}
          >
            <ChevronRight size={13} />
          </button>
          <button
            type="button"
            onClick={() => navigate(`/folders/${folder.id}`)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {active || isOpen ? (
              <FolderOpen size={14} className={active ? 'text-accent' : 'text-faint'} />
            ) : (
              <FolderIcon size={14} className="text-faint" />
            )}
            <span className="truncate text-[12.5px]">{folder.name}</span>
          </button>
          {folder.assetCount > 0 ? (
            <span className="shrink-0 text-[10.5px] tabular-nums text-faint opacity-0 transition-opacity group-hover:opacity-100">
              {formatCount(folder.assetCount)}
            </span>
          ) : null}
        </div>
        {isOpen
          ? kids.map((child) => renderFolder(child, depth + 1))
          : null}
      </div>
    )
  }

  if (!root) return null
  const top = children.get(root.id) ?? []
  return <div className="space-y-px">{top.map((folder) => renderFolder(folder, 0))}</div>
}
