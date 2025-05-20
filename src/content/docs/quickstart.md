---
title: "Quick Start Guide"
description: "Get started with Gitea Mirror quickly."
order: 3
updatedDate: 2023-10-15
---

<div class="mb-6">
  <h1 class="text-2xl font-bold text-foreground">Gitea Mirror Quick Start Guide</h1>
  <p class="text-muted-foreground mt-2">This guide will help you get Gitea Mirror up and running quickly.</p>
</div>

## Prerequisites

Before you begin, make sure you have:

1. <span class="font-semibold text-foreground">A GitHub account with a personal access token</span>
2. <span class="font-semibold text-foreground">A Gitea instance with an access token</span>
3. <span class="font-semibold text-foreground">Docker and docker-compose (recommended) or Bun 1.2.9+ installed</span>

## Installation Options

Choose the installation method that works best for your environment.

### Using Docker (Recommended)

Docker provides the easiest way to get started with minimal configuration.

1. Clone the repository:
   ```bash
   git clone https://github.com/arunavo4/gitea-mirror.git
   cd gitea-mirror
   ```

2. Start the application in production mode:
   ```bash
   docker-compose --profile production up -d
   ```

3. Access the application at [http://localhost:4321](http://localhost:4321)

### Manual Installation

If you prefer to run the application directly on your system:

1. Clone the repository:
   ```bash
   git clone https://github.com/arunavo4/gitea-mirror.git
   cd gitea-mirror
   ```

2. Run the quick setup script:
   ```bash
   pnpm setup
   ```
   This installs dependencies and initializes the database.

3. Choose how to run the application:

   **Development Mode:**
   ```bash
   pnpm dev
   ```

   **Production Mode:**
   ```bash
   pnpm build
   pnpm start
   ```

4. Access the application at [http://localhost:4321](http://localhost:4321)

## Initial Configuration

Follow these steps to configure Gitea Mirror for first use:

1. **Create Admin Account**
   - Upon first access, you'll be prompted to create an admin account
   - Choose a secure username and password
   - This will be your administrator account

2. **Configure GitHub Connection**
   - Navigate to the Configuration page
   - Enter your GitHub username
   - Enter your GitHub personal access token
   - Select which repositories to mirror (all, starred, organizations)
   - Configure repository filtering options

3. **Configure Gitea Connection**
   - Enter your Gitea server URL
   - Enter your Gitea access token
   - Configure organization and visibility settings

4. **Set Up Scheduling (Optional)**
   - Enable automatic mirroring if desired
   - Set the mirroring interval (in seconds)

5. **Save Configuration**
   - Click the "Save" button to store your settings

## Performing Your First Mirror

After completing the configuration, you can start mirroring repositories:

1. Click "Import GitHub Data" to fetch repositories from GitHub
2. Go to the Repositories page to view your imported repositories
3. Select the repositories you want to mirror
4. Click "Mirror Selected" to start the mirroring process
5. Monitor the progress on the Activity page
6. You'll receive toast notifications about the success or failure of operations

## Troubleshooting

If you encounter any issues:

- Check the Activity Log for detailed error messages
- Verify your GitHub and Gitea tokens have the correct permissions
- Ensure your Gitea instance is accessible from the machine running Gitea Mirror
- For Docker installations, check container logs with `docker logs gitea-mirror`

## Next Steps

After your initial setup:

- Explore the dashboard for an overview of your mirroring status
- Set up automatic mirroring schedules for hands-off operation
- Configure organization mirroring for team repositories
