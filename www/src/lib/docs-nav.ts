export interface DocsNavItem {
  title: string;
  href: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

export const docsNav: DocsNavSection[] = [
  {
    title: 'Getting Started',
    items: [
      { title: 'Quickstart', href: '/docs/quickstart/' },
      { title: 'Deployment', href: '/docs/deployment/' },
      { title: 'Tokens & Permissions', href: '/docs/tokens/' },
    ],
  },
  {
    title: 'Using It',
    items: [
      { title: 'Configuration Guide', href: '/docs/configuration/' },
      { title: 'Sources', href: '/docs/sources/' },
      { title: 'Destinations', href: '/docs/destinations/' },
      { title: 'Repositories & Organizations', href: '/docs/repositories-and-organizations/' },
      { title: 'Cleanup & Reconcile', href: '/docs/cleanup-and-reconcile/' },
      { title: 'Notifications', href: '/docs/notifications/' },
      { title: 'Force-Push Protection', href: '/docs/force-push-protection/' },
    ],
  },
  {
    title: 'Operating',
    items: [
      { title: 'Authentication & SSO', href: '/docs/authentication/' },
      { title: 'Reverse Proxy & URLs', href: '/docs/reverse-proxy/' },
      { title: 'Backups & Upgrades', href: '/docs/backups-and-upgrades/' },
      { title: 'Custom CA Certificates', href: '/docs/ca-certificates/' },
      { title: 'Advanced', href: '/docs/advanced/' },
      { title: 'Troubleshooting', href: '/docs/troubleshooting/' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { title: 'Environment Variables', href: '/docs/environment-variables/' },
      { title: 'API & API Keys', href: '/docs/api/' },
      { title: 'MCP Server', href: '/docs/mcp/' },
      { title: 'Architecture', href: '/docs/architecture/' },
    ],
  },
];

/** The pages before and after `path` in reading order, for the links under each page. */
export function docsNeighbours(path: string): { prev?: DocsNavItem; next?: DocsNavItem } {
  const pages = docsNav.flatMap((section) => section.items);
  const index = pages.findIndex((item) => item.href === path);
  if (index === -1) return {};
  return { prev: pages[index - 1], next: pages[index + 1] };
}
