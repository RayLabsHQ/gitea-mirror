# Development Workflow

This guide covers the development workflow for the open-source Gitea Mirror.

## Getting Started

### Prerequisites

- Bun >= 1.2.9
- Node.js >= 20
- Git
- GitHub account (for API access)
- Gitea instance (for testing)

### Initial Setup

1. **Clone the repository**:
```bash
git clone https://github.com/RayLabsHQ/gitea-mirror.git
cd gitea-mirror
```

2. **Install dependencies and seed the SQLite database**:
```bash
bun run setup
```

3. **Configure environment (optional)**:
```bash
cp .env.example .env
# Edit .env with your settings
```

4. **Start the development server**:
```bash
bun run dev
```

## Development Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start the Bun + Astro dev server with hot reload |
| `bun run build` | Build the production bundle |
| `bun run preview` | Preview the production build locally |
| `bun test` | Run the Bun test suite |
| `bun test:watch` | Run tests in watch mode |
| `bun run db:studio` | Launch Drizzle Kit Studio |

## Project Structure

```
gitea-mirror/
├── src/                     # Application UI, API routes, and services
│   ├── components/          # React components rendered inside Astro pages
│   ├── pages/               # Astro pages and API routes (e.g., /api/*)
│   ├── lib/                 # Core logic: GitHub/Gitea clients, scheduler, recovery, db helpers
│   │   ├── db/              # Drizzle adapter + schema
│   │   ├── modules/         # Module wiring (jobs, integrations)
│   │   └── utils/           # Shared utilities
│   ├── hooks/               # React hooks
│   ├── content/             # In-app documentation and templated content
│   ├── layouts/             # Shared layout components
│   ├── styles/              # Tailwind CSS entrypoints
│   └── types/               # TypeScript types
├── scripts/                 # Bun scripts for DB management and maintenance
├── www/                     # Marketing site (Astro + MDX use cases)
├── public/                  # Static assets served by Vite/Astro
└── tests/                   # Dedicated integration/unit test helpers
```

## Feature Development

### Adding a New Feature

1. **Create feature branch**:
```bash
git checkout -b feature/my-feature
```

2. **Plan your changes**:
- UI components live in `src/components/`
- API endpoints live in `src/pages/api/`
- Database logic is under `src/lib/db/` (schema + adapter)
- Shared types are in `src/types/`

3. **Implement the feature**:

**Example: Adding a new API endpoint**
```typescript
// src/pages/api/my-endpoint.ts
import type { APIRoute } from 'astro';
import { getUserFromCookie } from '@/lib/auth-utils';

export const GET: APIRoute = async ({ request }) => {
  const user = await getUserFromCookie(request);
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Your logic here
  return new Response(JSON.stringify({ data: 'success' }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
```

4. **Write tests**:
```typescript
// src/lib/my-feature.test.ts
import { describe, it, expect } from 'bun:test';

describe('My Feature', () => {
  it('should work correctly', () => {
    expect(myFunction()).toBe('expected');
  });
});
```

5. **Update documentation**:
- Add JSDoc comments
- Update README/docs if needed
- Document API changes

## Database Development

### Schema Changes

1. **Modify schema**:
```typescript
// src/lib/db/schema.ts
export const myTable = sqliteTable('my_table', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});
```

2. **Generate migration**:
```bash
bun run db:generate
```

3. **Apply migration**:
```bash
bun run db:migrate
```

### Writing Queries

```typescript
// src/lib/db/queries/my-queries.ts
import { db } from '../index';
import { myTable } from '../schema';

export async function getMyData(userId: string) {
  return db.select()
    .from(myTable)
    .where(eq(myTable.userId, userId));
}
```

## Testing

### Unit Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test auth

# Watch mode
bun test:watch

# Coverage
bun test:coverage
```

### Manual Testing Checklist

- [ ] Feature works as expected
- [ ] No console errors
- [ ] Responsive on mobile
- [ ] Handles errors gracefully
- [ ] Loading states work
- [ ] Form validation works
- [ ] API returns correct status codes

## Debugging

### VSCode Configuration

Create `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "bun",
      "request": "launch", 
      "name": "Debug Bun",
      "program": "${workspaceFolder}/src/index.ts",
      "cwd": "${workspaceFolder}",
      "env": {
        "NODE_ENV": "development"
      }
    }
  ]
}
```

### Debug Logging

```typescript
// Development only logging
if (import.meta.env.DEV) {
  console.log('[Debug]', data);
}
```

## Code Style

### TypeScript

- Use strict mode
- Define interfaces for all data structures
- Avoid `any` type
- Use proper error handling

### React Components

- Use functional components
- Implement proper loading states
- Handle errors with error boundaries
- Use TypeScript for props

### API Routes

- Always validate input
- Return proper status codes
- Use consistent error format
- Document with JSDoc

## Git Workflow

### Commit Messages

Follow conventional commits:
```
feat: add repository filtering
fix: resolve sync timeout issue
docs: update API documentation
style: format code with prettier
refactor: simplify auth logic
test: add user creation tests
chore: update dependencies
```

### Pull Request Process

1. Create feature branch
2. Make changes
3. Write/update tests
4. Update documentation
5. Create PR with description
6. Address review feedback
7. Squash and merge

## Performance

### Development Tips

- Use React DevTools
- Monitor bundle size
- Profile database queries
- Check memory usage

### Optimization

- Lazy load components
- Optimize images
- Use database indexes
- Cache API responses

## Common Issues

### Port Already in Use

```bash
# Use different port
PORT=3001 bun run dev
```

### Database Locked

```bash
# Reset database
bun run cleanup-db
bun run init-db
```

### Type Errors

```bash
# Check types
bunx tsc --noEmit
```

## Release Process

1. **Update version**:
```bash
npm version patch  # or minor/major
```

2. **Update CHANGELOG.md**

3. **Build and test**:
```bash
bun run build
bun test
```

4. **Create release**:
```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

5. **Create GitHub release**

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to your fork
5. Create a Pull Request

## Resources

- [Astro Documentation](https://docs.astro.build)
- [Bun Documentation](https://bun.sh/docs)
- [Drizzle ORM](https://orm.drizzle.team)
- [React Documentation](https://react.dev)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## Getting Help

- Check existing [issues](https://github.com/RayLabsHQ/gitea-mirror/issues)
- Join [discussions](https://github.com/RayLabsHQ/gitea-mirror/discussions)
- Review project docs in [docs/README.md](./README.md)
