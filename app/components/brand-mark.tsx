export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 28 28" focusable="false">
        <path className="brand-mark-grid" d="M5 21V7M5 21H23" />
        <path className="brand-mark-signal" d="m7 18 4-5 4 2 6-8" />
        <circle cx="7" cy="18" r="1.5" />
        <circle cx="11" cy="13" r="1.5" />
        <circle cx="15" cy="15" r="1.5" />
        <circle className="brand-mark-end" cx="21" cy="7" r="2" />
      </svg>
    </span>
  );
}
