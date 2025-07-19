import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();
declare global {

  var _redisClient: ReturnType<typeof createClient> | undefined;
}

const client = globalThis._redisClient ?? createClient({
  username: 'default',
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
  },
});

if (!global._redisClient) {
  client.on('error', (err) => console.error('Redis Client Error', err));
  (async () => {
    if (!client.isOpen) {
      await client.connect();
      console.log('Redis client connected');
    }
  })();
  global._redisClient = client;
} else {
  console.log('Redis client reused from global');
}

export default client;
