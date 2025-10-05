# Gitea Mirror Documentation

Welcome to the Gitea Mirror documentation. This guide covers everything you need to know about developing, building, and deploying the open-source version of Gitea Mirror.

## Documentation Overview

### Getting Started

- **[Development Workflow](./DEVELOPMENT_WORKFLOW.md)** - Set up your development environment and start contributing
- **[Build Guide](./BUILD_GUIDE.md)** - Build Gitea Mirror from source
- **[Configuration Guide](./CONFIGURATION.md)** - Configure all available options

### Deployment

- **[Deployment Guide](./DEPLOYMENT.md)** - Deploy to production environments
- **[Docker Guide](./DOCKER.md)** - Container-based deployment
- **[Reverse Proxy Setup](./REVERSE_PROXY.md)** - Configure with nginx/Caddy

### Features

- **[SSO/OIDC Setup](./SSO-OIDC-SETUP.md)** - Configure authentication providers
- **[Sponsor Integration](./SPONSOR_INTEGRATION.md)** - GitHub Sponsors integration
- **[Webhook Configuration](./WEBHOOKS.md)** - Set up GitHub webhooks

### Marketing Site

- **Use Case Library** (`www/src/pages/use-cases/`) - MDX guides surfaced on the landing page use case section
- **Use Case Cards** (`www/src/lib/use-cases.ts`) - Central place to update titles, summaries, and CTA links shown across the site

### Architecture

- **[Architecture Overview](./ARCHITECTURE.md)** - System design and components
- **[API Documentation](./API.md)** - REST API endpoints
- **[Database Schema](./DATABASE.md)** - SQLite structure

### Maintenance

- **[Migration Guide](../MIGRATION_GUIDE.md)** - Upgrade from previous versions
- **[Better Auth Migration](./BETTER_AUTH_MIGRATION.md)** - Migrate authentication system
- **[Troubleshooting](./TROUBLESHOOTING.md)** - Common issues and solutions
- **[Backup & Restore](./BACKUP.md)** - Data management

## Quick Start

1. **Clone and install**:
```bash
git clone https://github.com/yourusername/gitea-mirror.git
cd gitea-mirror
bun install
```

2. **Configure**:
```bash
cp .env.example .env
# Edit .env with your GitHub and Gitea tokens
```

3. **Initialize and run**:
```bash
bun run init-db
bun run dev
```

4. **Access**: Open http://localhost:4321

## Key Features

- 🔄 **Automatic Syncing** - Keep repositories synchronized
- 🗂️ **Organization Support** - Mirror entire organizations
- ⭐ **Starred Repos** - Mirror your starred repositories
- 🔐 **Self-Hosted** - Full control over your data
- 🚀 **Fast** - Built with Bun for optimal performance
- 🔒 **Secure** - JWT authentication, encrypted tokens

## Technology Stack

- **Runtime**: Bun
- **Framework**: Astro with React
- **Database**: SQLite with Drizzle ORM
- **Styling**: Tailwind CSS v4
- **Authentication**: Better Auth

## System Requirements

- Bun >= 1.2.9
- Node.js >= 20 (optional, for compatibility)
- SQLite 3
- 512MB RAM minimum
- 1GB disk space

## Contributing

We welcome contributions! Please see our [Contributing Guide](../CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

### Code of Conduct

Please read our [Code of Conduct](../CODE_OF_CONDUCT.md) before contributing.

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/gitea-mirror/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/gitea-mirror/discussions)
- **Wiki**: [GitHub Wiki](https://github.com/yourusername/gitea-mirror/wiki)

## Security

For security issues, please see [SECURITY.md](../SECURITY.md).

## License

Gitea Mirror is open source software licensed under the [MIT License](../LICENSE).

---

For detailed information on any topic, please refer to the specific documentation guides listed above.
