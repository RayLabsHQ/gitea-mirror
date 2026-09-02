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
    ],
  },
  {
    title: 'Configuration',
    items: [
      { title: 'Configuration Guide', href: '/docs/configuration/' },
      { title: 'Sources', href: '/docs/sources/' },
      { title: 'Destinations', href: '/docs/destinations/' },
      { title: 'Environment Variables', href: '/docs/environment-variables/' },
    ],
  },
  {
    title: 'Features',
    items: [
      { title: 'Cleanup & Reconcile', href: '/docs/cleanup-and-reconcile/' },
      { title: 'Notifications', href: '/docs/notifications/' },
      { title: 'Authentication & SSO', href: '/docs/authentication/' },
      { title: 'Force-Push Protection', href: '/docs/force-push-protection/' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { title: 'API & API Keys', href: '/docs/api/' },
      { title: 'Architecture', href: '/docs/architecture/' },
      { title: 'Advanced', href: '/docs/advanced/' },
      { title: 'Custom CA Certificates', href: '/docs/ca-certificates/' },
    ],
  },
];
