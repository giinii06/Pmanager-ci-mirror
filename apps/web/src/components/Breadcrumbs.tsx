import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import type { FolderDTO } from '@mediavault/shared'

export function Breadcrumbs({ trail }: { trail: FolderDTO[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 pt-5 text-[12px] text-muted">
      <Link to="/folders" className="transition-colors hover:text-ink">
        폴더
      </Link>
      {trail.map((folder, index) => {
        const last = index === trail.length - 1
        return (
          <span key={folder.id} className="flex items-center gap-1">
            <ChevronRight size={12} className="text-faint" />
            {last ? (
              <span className="text-ink">{folder.name}</span>
            ) : (
              <Link
                to={`/folders/${folder.id}`}
                className="transition-colors hover:text-ink"
              >
                {folder.name}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
