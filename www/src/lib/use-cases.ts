export interface UseCase {
  slug: string;
  title: string;
  summary: string;
  painPoint: string;
  outcome: string;
  tags: string[];
}

export const useCases: UseCase[] = [
  {
    slug: 'backup-github-repositories',
    title: 'Backup GitHub Repositories',
    summary: 'Continuously mirror GitHub repositories into self-hosted Gitea so your side projects stay safe even when GitHub hiccups.',
    painPoint: 'Homelabbers rely on GitHub availability but want local backups that preserve history, metadata, and LFS assets.',
    outcome: 'Automated syncs capture full repository history, metadata, and file storage so you always have an up-to-date local copy.',
    tags: ['Redundancy', 'Continuous Sync', 'Homelab'],
  },
  {
    slug: 'deploy-with-helm-chart',
    title: 'Deploy with Helm Chart',
    summary: 'Install the project on Kubernetes in a few commands using the maintained Helm chart to keep your backup mirror humming.',
    painPoint: 'Self-hosters want reproducible Git backups without hand-rolling manifests for every cluster or upgrade.',
    outcome: 'Versioned Helm values capture backup config, making redeploys and upgrades fast, scriptable, and low-risk.',
    tags: ['Kubernetes', 'Helm', 'Homelab'],
  },
  {
    slug: 'proxmox-lxc-homelab',
    title: 'Spin Up on Proxmox LXC',
    summary: 'Run the one-liner Proxmox VE script to launch gitea-mirror inside a tuned LXC container for your lab backups.',
    painPoint: 'Proxmox homelabbers want a repeatable Git backup without manually wiring containers, volumes, and services.',
    outcome: 'The community script provisions the container, installs Bun, and wires persistence so mirroring works minutes after boot.',
    tags: ['Proxmox', 'Automation', 'Homelab'],
  },
  {
    slug: 'sync-github-to-self-hosted-gitea',
    title: 'Sync GitHub to Self-Hosted Gitea',
    summary: 'Run continuous mirrors so your homelab Gitea instance stays in lockstep with GitHub without manual pulls.',
    painPoint: 'Tinkerers want to keep a local Gitea in sync but `git pull --mirror` cron jobs break on metadata and new repos.',
    outcome: 'Gitea Mirror auto-discovers repos, syncs metadata, and respects intervals so your LAN copy matches upstream every hour.',
    tags: ['Continuous Sync', 'Self-Hosted', 'Homelab'],
  },
  {
    slug: 'preserve-github-history',
    title: 'Preserve GitHub History Forever',
    summary: 'Archive commit history, issues, and releases into Gitea so side projects survive account removals or repo deletion.',
    painPoint: 'Homelab archivists fear SaaS changes wiping years of work, but manual exports miss metadata and LFS assets.',
    outcome: 'Scheduled mirrors capture full history with metadata snapshots, giving you an air-gapped archive you control.',
    tags: ['Archival', 'Metadata', 'Homelab'],
  },
  {
    slug: 'github-backup-automation',
    title: 'Automate GitHub Backups',
    summary: 'Replace brittle scripts with policy-driven schedules, health checks, and alerts that keep your Git backups honest.',
    painPoint: 'Cron jobs and shell scripts fail silently, leaving you with stale mirrors when you need a restore most.',
    outcome: 'Gitea Mirror tracks sync status, retries failures, and exposes health endpoints so you can trust every backup window.',
    tags: ['Automation', 'Observability', 'Homelab'],
  },
  {
    slug: 'starred-repos-collection',
    title: 'Build a Starred Repo Collection',
    summary: 'Mirror starred GitHub projects into your own Gitea library so favorites stay browsable even when upstream disappears.',
    painPoint: 'Curators star dozens of repos but lose them when owners delete or rename, and there’s no offline copy.',
    outcome: 'The starred collector funnels every star into a dedicated Gitea org with metadata intact for long-term tinkering.',
    tags: ['Curation', 'Automation', 'Homelab'],
  },
  {
    slug: 'vendor-lock-in-prevention',
    title: 'Stay Ready to Leave GitHub',
    summary: 'Keep an always-current mirror so you can pivot from GitHub to self-hosted tooling whenever policies shift.',
    painPoint: 'Indie builders worry about pricing, auth changes, or ToS updates but lack a live fallback they can swap to instantly.',
    outcome: 'Continuous mirrors mean you can flip DNS to Gitea, keep working locally, and evaluate alternatives without downtime.',
    tags: ['Vendor Independence', 'Continuity', 'Homelab'],
  },
];
