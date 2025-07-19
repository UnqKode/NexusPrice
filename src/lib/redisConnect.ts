import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();
declare global {
  // This avoids redeclaring the client on hot reloads (Next.js dev)
  // @ts-ignore
  var _redisClient: ReturnType<typeof createClient> | undefined;
}

const client = global._redisClient ?? createClient({
  username: 'default',
  password: 'kT94DTMsUJiqwHwo5qthxj8nldrQIS5J',
  socket: {
    host: 'redis-15888.c212.ap-south-1-1.ec2.redns.redis-cloud.com',
    port: 15888,
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
