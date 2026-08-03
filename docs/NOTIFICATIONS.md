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

### 3. Gotify (Direct)

[Gotify](https://gotify.net/) is a simple self-hosted push notification server.

**Setup:**
1. In Gotify, create an application and copy its token
2. In Gitea Mirror, go to **Configuration > Notifications**
3. Enable notifications and select **Gotify**
4. Set the **Server URL** to your Gotify instance (e.g., `https://gotify.example.com`)
5. Paste the **Application token**
6. Pick a **Default priority** (0 to 10; error notifications are always sent at priority 8)

The token is encrypted at rest like all other provider credentials.

### 4. Webhook (Generic)

Sends a plain JSON POST to any URL you control. Works with n8n, Home Assistant, or any service that accepts a generic webhook.

**Setup:**
1. In Gitea Mirror, go to **Configuration > Notifications**
2. Enable notifications and select **Webhook**
3. Set the **Webhook URL** to your endpoint
4. Optionally set a **Signing secret**

**Payload:**
```json
{
  "title": "Mirror Failed: my-repo",
  "message": "Repository my-repo failed to mirror",
  "type": "sync_error",
  "timestamp": "2026-08-03T02:33:29.707Z"
}
```

**Signature verification:**
When a signing secret is set, every request includes an `X-Webhook-Signature` header containing `sha256=<hex>`, an HMAC-SHA256 digest of the raw request body. Verify it on the receiving end:

```js
const crypto = require("node:crypto");
const expected = "sha256=" +
  crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const valid = crypto.timingSafeEqual(
  Buffer.from(signatureHeader), Buffer.from(expected));
```

The secret is encrypted at rest.

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
