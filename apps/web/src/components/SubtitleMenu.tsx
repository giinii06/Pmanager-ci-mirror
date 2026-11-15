import { useEffect, useRef, useState } from 'react'
import { Captions, CaptionsOff, Check } from 'lucide-react'
import type { SubtitleTrackDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'

const LANGUAGE_NAME: Record<string, string> = {
  ko: '한국어',
  en: '영어',
  ja: '일본어',
  zh: '중국어',
  es: '스페인어',
  fr: '프랑스어',
  de: '독일어',
  ru: '러시아어',
  vi: '베트남어',
  th: '태국어',
  id: '인도네시아어',
  pt: '포르투갈어',
  it: '이탈리아어',
  ar: '아랍어',
  hi: '힌디어',
  nl: '네덜란드어',
  tr: '터키어',
  pl: '폴란드어',
  sv: '스웨덴어',
  uk: '우크라이나어',
}

/** Language tags can carry a region (`ko-KR`), so match on the base tag. */
export function languageName(tag: string): string {
  const base = tag.trim().toLowerCase().split(/[-_]/)[0] ?? tag
  return LANGUAGE_NAME[base] ?? base.toUpperCase()
}

export function trackLabel(track: SubtitleTrackDTO): string {
  const name = languageName(track.language)
  return track.source === 'asr' ? `${name} (AI)` : `${name} (AI 번역)`
}

export function SubtitleMenu({
  tracks,
  language,
  onSelect,
}: {
  tracks: SubtitleTrackDTO[]
  language: string | null
  onSelect: (language: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const ready = tracks.filter((track) => track.ready)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Capture phase, so the lightbox does not also close on the same Escape.
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  if (ready.length === 0) return null

  const item = (active: boolean) =>
    cn(
      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-white/8',
      active ? 'text-ink' : 'text-muted',
    )
  const tick = (active: boolean) =>
    cn('shrink-0', active ? 'text-accent' : 'invisible')

  return (
    <div ref={root} className="absolute right-2 top-2 z-20">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="자막 언어"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11.5px] backdrop-blur-sm transition-colors',
          open
            ? 'bg-black/80 text-white'
            : 'bg-black/55 text-white/85 hover:bg-black/75 hover:text-white',
        )}
      >
        {language ? <Captions size={13} /> : <CaptionsOff size={13} />}
        <span>{language ? languageName(language) : '자막 끔'}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-[172px] rounded-lg border border-white/10 bg-[#0b0c0f]/97 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
        >
          {ready.map((track) => (
            <button
              key={track.language}
              type="button"
              role="menuitemradio"
              aria-checked={track.language === language}
              onClick={() => {
                onSelect(track.language)
                setOpen(false)
              }}
              className={item(track.language === language)}
            >
              <Check size={12} className={tick(track.language === language)} />
              <span className="truncate">{trackLabel(track)}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-white/10" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={language === null}
            onClick={() => {
              onSelect(null)
              setOpen(false)
            }}
            className={item(language === null)}
          >
            <Check size={12} className={tick(language === null)} />
            <span>자막 끄기</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
