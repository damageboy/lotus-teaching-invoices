interface Props {
  className: string;
  dateMarker?: boolean;
}

export function UnconfiguredMarker({ className, dateMarker = false }: Props) {
  return (
    <svg
      data-unconfigured-marker={dateMarker ? 'true' : undefined}
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={className}
    >
      <circle cx="6" cy="6" r="6" fill="#dc2626" />
      <path
        d="M3.88 2.82 6 4.94 8.12 2.82 9.18 3.88 7.06 6 9.18 8.12 8.12 9.18 6 7.06 3.88 9.18 2.82 8.12 4.94 6 2.82 3.88Z"
        fill="white"
      />
    </svg>
  );
}
