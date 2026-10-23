import type { ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  folder: <path d="M3 6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  table: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 9h14M8 4v12" />
    </>
  ),
  code: <path d="M7 6l-4 4 4 4M13 6l4 4-4 4" />,
  chart: <path d="M5 16V9M10 16V4M15 16v-5" />,
  list: <path d="M4 5h12M4 10h12M4 15h7" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l3 2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h7M15 6h1M4 14h1M9 14h7" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="7" cy="14" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.5 13.5L17 17" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h6l3 3v11H6z" />
      <path d="M12 3v3h3" />
    </>
  ),
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  dash: <path d="M5 10h10" />,
  chevron: <path d="M6 8l4 4 4-4" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  logout: <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12 6l4 4-4 4M16 10H8" />,
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5v.01" />
    </>
  ),
  plus: <path d="M10 4v12M4 10h12" />,
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />,
  bucket:<path d="M4 5h12l-1.5 11a1 1 0 0 1-1 .9h-7a1 1 0 0 1-1-.9zM4 5c0-1 2.7-2 6-2s6 1 6 2" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, className = "ic" }: { name: IconName; className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
