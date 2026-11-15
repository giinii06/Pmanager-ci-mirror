import { Link } from 'react-router-dom'
import { ChevronRight, Folder as FolderIcon } from 'lucide-react'
import type { FolderDTO } from '@mediavault/shared'
import { formatCount } from '../lib/format'
import { Thumb } from './Thumb'

export function FolderCard({ folder }: { folder: FolderDTO }) {
  return (
    <Link
      to={`/folders/${folder.id}`}
      className="group overflow-hidden rounded-panel border border-line bg-panel transition-colors duration-150 hover:border-line-strong"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-panel-2">
        {folder.coverAssetId ? (
          <Thumb
            src={`/api/assets/${folder.coverAssetId}/thumbnail?size=640`}
            alt=""
            className="h-full w-full"
            imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-faint">
            <FolderIcon size={26} strokeWidth={1.4} />
          </div>
        )}
        <span className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent opacity-70" />
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{folder.name}</p>
          <p className="text-[11.5px] text-muted">{formatCount(folder.assetCount)}개</p>
        </div>
        <ChevronRight
          size={14}
          className="text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted"
        />
      </div>
    </Link>
  )
}
