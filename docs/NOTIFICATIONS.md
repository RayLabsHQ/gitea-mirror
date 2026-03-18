# Notifications

Gitea Mirror supports push notifications for mirror events. You can be alerted when jobs succeed, fail, or when new repositories are discovered.

## Supported Providers

### 1. Ntfy.sh (Direct)

[Ntfy.sh](https://ntfy.sh) is a simple HTTP-based pub-sub notification service. You can use the public server at `https://ntfy.sh` or self-host your own instance.

**Setup (public server):**
1. Go to **Configuration > Notifications**
2. Enable notifications and select **Ntfy.sh** as the provider
3. Set the **Topic** to a unique name (e.g., `my-gitea-mirror-abc123`)
4. Leave the Server URL as `https://ntfy.sh`
5. Subscribe to the same topic on your phone or desktop using the [ntfy app](https://ntfy.sh/docs/subscribe/phone/)

**Setup (self-hosted):**
1. Deploy ntfy using Docker: `docker run -p 8080:80 binwiederhier/ntfy serve`
2. Set the **Server URL** to your instance (e.g., `http://ntfy:8080`)
3. If authentication is enabled, provide an **Access token**
4. Set your **Topic** name

**Priority levels:**
- `min` / `low` / `default` / `high` / `urgent`
- Error notifications automatically use `high` priority regardless of the default setting

### 2. Apprise API (Aggregator)

[Apprise](https://github.com/caronc/apprise-api) is a notification aggregator that supports 100+ services (Slack, Discord, Telegram, Email, Pushover, and many more) through a single API.

**Setup:**
1. Deploy the Apprise API server:
   ```yaml
   # docker-compose.yml
   services:
     apprise:
       image: caronc/apprise:latest
       ports:
         - "8000:8000"
       volumes:
         - apprise-config:/config
   volumes:
     apprise-config:
   ```
2. Configure your notification services in Apprise (via its web UI at `http://localhost:8000` or API)
3. Create a configuration token/key in Apprise
4. In Gitea Mirror, go to **Configuration > Notifications**
5. Enable notifications and select **Apprise API**
6. Set the **Server URL** to your Apprise instance (e.g., `http://apprise:8000`)
7. Enter the **Token/path** you created in step 3

**Tag filtering:**
- Optionally set a **Tag** to only notify specific Apprise services
- Leave empty to notify all configured services

## Event Types

| Event | Default | Description |
|-------|---------|-------------|
| Sync errors | On | A mirror job failed |
| Sync success | Off | A mirror job completed successfully |
| New repo discovered | Off | A new GitHub repo was auto-imported during scheduled sync |

## Testing

Use the **Send Test Notification** button on the Notifications settings page to verify your configuration. The test sends a sample success notification to your configured provider.

## Troubleshooting

**Notifications not arriving:**
- Check that notifications are enabled in the settings
- Verify the provider configuration (URL, topic/token)
- Use the Test button to check connectivity
- Check the server logs for `[NotificationService]` messages

**Ntfy authentication errors:**
- Ensure your access token is correct
- If self-hosting, verify the ntfy server allows the topic

**Apprise connection refused:**
- Verify the Apprise API server is running and accessible from the Gitea Mirror container
- If using Docker, ensure both containers are on the same network
- Check the Apprise server logs for errors

**Tokens and security:**
- Notification tokens (ntfy access tokens, Apprise tokens) are encrypted at rest using the same AES-256-GCM encryption as GitHub/Gitea tokens
- Tokens are decrypted only when sending notifications or displaying in the settings UI
