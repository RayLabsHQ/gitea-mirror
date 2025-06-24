# Developer Guide

This guide is for developers who want to contribute to or modify Gitea Mirror.

## Table of Contents
- [Architecture Overview](#architecture-overview)
- [Development Setup](#development-setup)
- [Code Structure](#code-structure)
- [Common Tasks](#common-tasks)
- [Testing](#testing)
- [Advanced Topics](#advanced-topics)

## Architecture Overview

### Technology Stack
- **Frontend**: Astro (SSR) + React + Tailwind CSS v4
- **Backend**: Bun runtime + SQLite database
- **Authentication**: JWT + OIDC + Forward Auth
- **APIs**: GitHub (Octokit) + Gitea REST

### Key Concepts
1. **Server-Side Rendering**: Astro handles SSR for better performance
2. **API Routes**: All endpoints live in `/src/pages/api/`
3. **Database**: SQLite with Drizzle ORM for type safety
4. **Real-time Updates**: Server-Sent Events (SSE) for live updates

## Development Setup

### Prerequisites

```bash
# Install Bun (JavaScript runtime)
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version  # Should be >= 1.2.9
```

### Quick Start

```bash
# 1. Clone and setup
git clone https://github.com/arunavo4/gitea-mirror.git
cd gitea-mirror
bun install

# 2. Initialize database
bun run setup

# 3. Start development server
bun run dev

# Visit http://localhost:3000
```

### Environment Setup

Create `.env` for development:

```bash
# Development settings
NODE_ENV=development
PORT=3000
JWT_SECRET=dev-secret

# Test with your GitHub account
GITHUB_USERNAME=your-username
GITHUB_TOKEN=ghp_your_token

# Optional: Local Gitea for testing
GITEA_URL=http://localhost:3001
GITEA_TOKEN=your-local-token
```

## Code Structure

```
src/
├── pages/          # Astro pages & API routes
│   ├── api/        # REST API endpoints
│   │   ├── auth/   # Authentication endpoints
│   │   ├── repos/  # Repository management
│   │   └── ...
│   └── *.astro     # UI pages
├── components/     # React components
│   ├── ui/         # Reusable UI components
│   └── [feature]/  # Feature-specific components
├── lib/            # Core business logic
│   ├── db/         # Database layer
│   │   ├── schema.ts    # Table definitions
│   │   └── queries/     # Database queries
│   ├── auth/       # Authentication logic
│   └── gitea.ts    # Gitea API integration
├── hooks/          # Custom React hooks
└── types/          # TypeScript type definitions
```

## Common Tasks

### Adding a New API Endpoint

1. Create endpoint file:

```typescript
// src/pages/api/repos/stats.ts
import type { APIRoute } from "astro";
import { getUserFromCookie } from "@/lib/auth";
import { getRepoStats } from "@/lib/db/queries/repos";

export const GET: APIRoute = async ({ request }) => {
  // 1. Authentication
  const user = await getUserFromCookie(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 2. Business logic
  const stats = await getRepoStats(user.id);

  // 3. Response
  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
```

2. Add database query:

```typescript
// src/lib/db/queries/repos.ts
export async function getRepoStats(userId: string) {
  const stats = await db
    .select({
      total: count(),
      mirrored: count(eq(repositories.status, "mirrored")),
    })
    .from(repositories)
    .where(eq(repositories.userId, userId));
    
  return stats[0];
}
```

### Adding a React Component

```typescript
// src/components/repos/RepoStats.tsx
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';

export function RepoStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/repos/stats')
      .then(res => res.json())
      .then(data => {
        setStats(data);
        setLoading(false);
      });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <Card className="p-4">
      <h3>Repository Statistics</h3>
      <p>Total: {stats.total}</p>
      <p>Mirrored: {stats.mirrored}</p>
    </Card>
  );
}
```

### Database Schema Changes

1. Update schema:

```typescript
// src/lib/db/schema.ts
export const repositorySchema = z.object({
  // ... existing fields
  lastChecked: z.date().optional(), // New field
});
```

2. Create migration:

```typescript
// src/lib/db/migrations.ts
const migrations = [
  {
    column: "last_checked",
    sql: "ALTER TABLE repositories ADD COLUMN last_checked INTEGER"
  }
];
```

3. Run migration:

```bash
bun run init-db
```

## Testing

### Unit Tests

```typescript
// src/lib/utils.test.ts
import { describe, test, expect } from "bun:test";
import { formatDate } from "./utils";

describe("formatDate", () => {
  test("formats date correctly", () => {
    const date = new Date("2024-01-01");
    expect(formatDate(date)).toBe("Jan 1, 2024");
  });
});
```

Run tests:

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
bun test utils.test   # Specific file
```

### Integration Testing

Test with local Gitea:

```bash
# 1. Start Gitea and Gitea Mirror
docker compose -f docker-compose.dev.yml up -d

# 2. Access Gitea at http://localhost:3001
# 3. Create user and generate token
# 4. Configure in Gitea Mirror UI
```

### Manual Testing Checklist

- [ ] User signup/login flow
- [ ] GitHub connection setup
- [ ] Repository discovery
- [ ] Mirror operation
- [ ] Organization mirroring
- [ ] Authentication methods

## Advanced Topics

### Authentication System

The app supports three authentication methods:

1. **Local Auth** (default)
   - Uses bcrypt for passwords
   - JWT tokens for sessions
   - Stored in SQLite database

2. **OIDC Authentication**
   - Supports any OpenID Connect provider
   - Auto-creates users on first login
   - Maps claims to user properties

3. **Forward Auth**
   - Reads headers from reverse proxy
   - Validates trusted proxy IPs
   - Auto-creates users if enabled

### Mirror Process

1. **Discovery Phase**
   - Fetch repos from GitHub API
   - Store metadata in database
   - Mark status as "imported"

2. **Mirror Phase**
   - Create/update Gitea repository
   - Set up mirroring configuration
   - Update status to "mirroring"

3. **Completion**
   - Verify mirror is active
   - Update status to "mirrored"
   - Log success event

### Database Operations

**Transactions:**
```typescript
await db.transaction(async (tx) => {
  await tx.update(repositories).set({ status: "mirroring" });
  await tx.insert(events).values({ type: "mirror_start" });
});
```

**Batch Operations:**
```typescript
const repoIds = ["id1", "id2", "id3"];
await db
  .update(repositories)
  .set({ status: "mirrored" })
  .where(inArray(repositories.id, repoIds));
```

### Performance Tips

1. **Use Database Indexes**
   ```sql
   CREATE INDEX idx_repos_user_status ON repositories(userId, status);
   ```

2. **Implement Caching**
   ```typescript
   const cache = new Map();
   
   export async function getCachedUser(id: string) {
     if (cache.has(id)) return cache.get(id);
     const user = await getUserById(id);
     cache.set(id, user);
     return user;
   }
   ```

3. **Optimize Queries**
   ```typescript
   // Bad: N+1 queries
   for (const repo of repos) {
     const org = await getOrg(repo.orgId);
   }
   
   // Good: Single query with join
   const reposWithOrgs = await db
     .select()
     .from(repositories)
     .leftJoin(organizations, eq(repositories.orgId, organizations.id));
   ```

### Debugging

1. **Enable Debug Logging**
   ```typescript
   if (process.env.NODE_ENV === 'development') {
     console.log('[DEBUG]', data);
   }
   ```

2. **Database Inspection**
   ```bash
   sqlite3 data/gitea-mirror.db
   .tables
   SELECT * FROM users;
   ```

3. **API Testing**
   ```bash
   # Test auth endpoint
   curl -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"test","password":"test"}'
   ```

### Build & Deployment

**Production Build:**
```bash
bun run build
bun run preview  # Test production build
```

**Docker Build:**
```bash
docker build -t gitea-mirror:dev .
docker run -p 4321:4321 gitea-mirror:dev
```

### Contributing Guidelines

1. **Code Style**
   - Use TypeScript for type safety
   - Follow existing patterns
   - Run formatter: `bun run format`

2. **Git Workflow**
   - Create feature branch
   - Write descriptive commits
   - Add tests for new features
   - Update documentation

3. **Pull Request Checklist**
   - [ ] Tests pass
   - [ ] Build succeeds
   - [ ] Documentation updated
   - [ ] No console.logs left

## Resources

- [Astro Documentation](https://docs.astro.build)
- [Bun Documentation](https://bun.sh/docs)
- [Drizzle ORM](https://orm.drizzle.team)
- [Shadcn UI](https://ui.shadcn.com)

For deployment and operations, see the [User Guide](./USER_GUIDE.md).