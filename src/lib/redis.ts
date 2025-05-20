import { RedisClient } from "bun";

// Connect to Redis using REDIS_URL environment variable or default to redis://redis:6379
// This ensures we have a fallback URL when running with Docker Compose
const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";

console.log(`Connecting to Redis at: ${redisUrl}`);

// Configure Redis client with connection options
function createClient() {
  return new RedisClient(redisUrl, {
    autoReconnect: true,
  });
}

export const redis = createClient();
export const redisPublisher = createClient();
export const redisSubscriber = createClient();

redis.onconnect = () => console.log("Connected to Redis server");
redis.onclose = (err) => {
  if (err) console.error("Disconnected from Redis server:", err);
};
