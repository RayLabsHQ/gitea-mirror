# Contributing to Gitea Mirror

Thank you for your interest in contributing to Gitea Mirror! This guide will help you get started with development.

## 🚀 Quick Start for Developers

```bash
# 1. Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/gitea-mirror.git
cd gitea-mirror

# 2. Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# 3. Install dependencies and setup database
bun run setup

# 4. Start development server
bun run dev

# Access at http://localhost:3000
```

## 📋 Prerequisites

- **Bun** 1.2.9 or later ([install](https://bun.sh))
- **Node.js** 18+ (for some tooling)
- **Git**
- **SQLite** (comes with most systems)
- **Docker** (optional, for testing with local Gitea)

## 🏗️ Project Structure

```
gitea-mirror/
├── src/
│   ├── pages/          # Astro pages and API routes
│   │   ├── api/        # API endpoints
│   │   └── *.astro     # Page components
│   ├── components/     # React components
│   │   ├── ui/         # Shadcn UI components
│   │   ├── auth/       # Authentication components
│   │   ├── config/     # Configuration forms
│   │   └── ...         # Feature-specific components
│   ├── lib/            # Core logic
│   │   ├── db/         # Database (Drizzle ORM)
│   │   │   ├── schema.ts    # Database schema
│   │   │   └── queries/     # Database queries
│   │   ├── auth/       # Authentication logic
│   │   └── ...         # Utilities and helpers
│   ├── hooks/          # React hooks
│   └── types/          # TypeScript types
├── scripts/            # Build and utility scripts
├── tests/              # Test files
└── data/              # SQLite database (git-ignored)
```

## 🛠️ Development Workflow

### 1. Database Setup

The database is automatically initialized on first run, but you can manage it manually:

```bash
# Initialize database
bun run init-db

# Check database status
bun run check-db

# Reset database (development only)
bun run dev:clean

# Reset users for testing signup flow
bun run reset-users
```

### 2. Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run specific test file
bun test src/lib/auth/auth.test.ts

# Run with coverage
bun test --coverage
```

### 3. Code Style

We use ESLint and Prettier. Most editors will auto-format on save.

```bash
# Check formatting
bun run lint

# Auto-fix issues
bun run lint:fix
```

### 4. Building

```bash
# Build for production
bun run build

# Preview production build
bun run preview
```

## 🔧 Common Development Tasks

### Adding a New API Endpoint

1. Create file in `/src/pages/api/[resource]/[action].ts`
2. Use consistent error handling:

```typescript
import type { APIRoute } from "astro";
import { createSecureErrorResponse } from "@/lib/utils/error-handler";

export const POST: APIRoute = async ({ request }) => {
  try {
    // Your logic here
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createSecureErrorResponse(error);
  }
};
```

3. Add database query in `/src/lib/db/queries/`
4. Update types in `/src/types/`

### Adding a New Component

1. Create component in appropriate directory:
   - `/src/components/ui/` - Reusable UI components
   - `/src/components/[feature]/` - Feature-specific components

2. Follow naming conventions:
   - Components: `PascalCase.tsx`
   - Hooks: `useCamelCase.ts`
   - Utilities: `kebab-case.ts`

3. Example component structure:

```typescript
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export function MyComponent() {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  
  // Component logic
  
  return (
    <div>
      {/* Component UI */}
    </div>
  );
}
```

### Working with the Database

1. **Schema changes** in `/src/lib/db/schema.ts`:

```typescript
// Add new field to existing table
export const userSchema = z.object({
  // existing fields...
  newField: z.string().optional(),
});
```

2. **Create a query** in `/src/lib/db/queries/`:

```typescript
export async function getActiveUsers() {
  return await db
    .select()
    .from(users)
    .where(eq(users.isActive, true));
}
```

3. **Run migrations** after schema changes:

```bash
bun run init-db
```

### Authentication Development

The app supports three auth methods. When developing auth features:

1. **Local auth** is always available (default)
2. **Test OIDC** with mock provider:

```bash
# Set in .env
AUTH_METHOD=oidc
AUTH_ALLOW_LOCAL_FALLBACK=true
AUTH_OIDC_ISSUER_URL=http://localhost:8080
# ... other OIDC settings
```

3. **Test Forward Auth** with headers:

```bash
# Test with curl
curl -H "X-Remote-User: testuser" \
     -H "X-Remote-Email: test@example.com" \
     http://localhost:3000/api/user
```

## 🐳 Testing with Local Gitea

For full integration testing:

```bash
# 1. Start local Gitea and Gitea Mirror
docker compose -f docker-compose.dev.yml up -d

# 2. Setup Gitea (http://localhost:3001)
#    - Create user
#    - Generate access token

# 3. Configure Gitea Mirror (http://localhost:3000)
#    - Use Gitea URL: http://gitea:3000
#    - Enter your Gitea token
```

## 📝 Writing Tests

1. **Unit tests** for utilities:

```typescript
import { describe, test, expect } from "bun:test";
import { myFunction } from "./my-module";

describe("myFunction", () => {
  test("should return expected value", () => {
    expect(myFunction("input")).toBe("expected");
  });
});
```

2. **Integration tests** for API endpoints:

```typescript
test("POST /api/auth/login", async () => {
  const response = await fetch("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "test123" }),
  });
  
  expect(response.status).toBe(200);
});
```

## 🚢 Deployment Testing

Test your changes in production mode:

```bash
# Build and run production locally
bun run build
bun run start

# Or use Docker
docker build -t gitea-mirror:dev .
docker run -p 4321:4321 gitea-mirror:dev
```

## 📦 Dependencies

- **Frontend**: Astro, React, Tailwind CSS v4, Shadcn UI
- **Backend**: Bun runtime, SQLite, Drizzle ORM
- **Auth**: JWT (jsonwebtoken), bcryptjs
- **APIs**: Octokit (GitHub), native fetch (Gitea)

To add a new dependency:

```bash
bun add package-name
bun add -d dev-package-name  # Dev dependency
```

## 🐛 Debugging Tips

1. **Enable debug logging**:

```typescript
console.log("[DEBUG]", "Your message", { data });
```

2. **Check browser console** for client-side errors

3. **Check server logs**:

```bash
# Development
bun run dev

# Docker
docker logs gitea-mirror -f
```

4. **Database inspection**:

```bash
# Open SQLite CLI
sqlite3 data/gitea-mirror.db

# Common queries
.tables
.schema users
SELECT * FROM users;
```

## 📚 Resources

- [Astro Documentation](https://docs.astro.build)
- [React Documentation](https://react.dev)
- [Shadcn UI Components](https://ui.shadcn.com)
- [Drizzle ORM](https://orm.drizzle.team)
- [Bun Documentation](https://bun.sh/docs)

## ✅ Pull Request Checklist

Before submitting a PR:

- [ ] Run `bun test` - all tests pass
- [ ] Run `bun run build` - builds successfully
- [ ] Add tests for new features
- [ ] Update documentation if needed
- [ ] Follow existing code style
- [ ] Test with local Gitea if touching mirror logic
- [ ] Update CHANGELOG.md for notable changes

## 🤝 Getting Help

- Check existing [issues](https://github.com/arunavo4/gitea-mirror/issues)
- Start a [discussion](https://github.com/arunavo4/gitea-mirror/discussions)
- Review [existing PRs](https://github.com/arunavo4/gitea-mirror/pulls) for examples

Thank you for contributing! 🎉