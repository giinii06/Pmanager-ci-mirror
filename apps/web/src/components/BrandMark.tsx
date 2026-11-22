const LOGO_SRC = '/brand-icon.png?v=1'

export function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <img
      src={LOGO_SRC}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      className="block shrink-0 rounded-full object-contain"
    />
  )
}
