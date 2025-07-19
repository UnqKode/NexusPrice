# 🧮 Historical Token Price Oracle with Interpolation Engine

A full-stack web application that allows users to query the historical price of any ERC-20 token on Ethereum or Polygon. If the exact price at a given timestamp is unavailable, the system intelligently interpolates it using the nearest known values. Built with Next.js, Node.js, Redis, MongoDB, and Alchemy SDK.

---

## 🚀 Features

- 🔍 Query historical price of a token at a specific timestamp
- ♻️ Intelligent interpolation when exact price data is missing
- 📈 Graphical view of token price over time (1D, 1W, 1M, All)
- 🧠 Token birthdate detection via first on-chain transfer
- 📅 Schedule full historical data fetch (from token creation → now)
- 🕓 View recently queried tokens for quick re-access
- ⚡ Redis caching for fast lookups
- 📊 Daily price storage in MongoDB
- 🔁 Background workers for scheduled fetching
- 💥 Graceful handling of Alchemy rate limits (429s)
- 🧠 Autonomous backend daemon on OneRender handling long processes in background

---

## 🛠️ Tech Stack

| Layer        | Tech                     | Purpose                                      |
|-------------|--------------------------|----------------------------------------------|
| Frontend     | Next.js, TailwindCSS     | Responsive UI, graph rendering               |
| Backend      | Node.js + Express        | API layer + interpolation logic              |
| Queue        | BullMQ                   | Background jobs for daily price fetching     |
| Worker       | OneRender (daemon)       | Always-on backend monitoring Redis           |
| Cache        | Redis                    | 5-minute TTL price caching                   |
| Database     | MongoDB                  | Long-term price storage                      |
| Web3         | Alchemy SDK              | Blockchain data provider (price + transfers) |

---

## 🖼️ System Architecture

```mermaid
graph LR
  A[Next.js Frontend] -->|Submit Token/Network| B[Node.js API]
  B --> C{Check Redis Cache}
  C -->|Cache Hit| D[Return Cached Price]
  C -->|Cache Miss| E[Query Alchemy API]
  E -->|Price Found| F[Store in Redis/MongoDB]
  E -->|Price Missing| G[Interpolation Engine]
  G --> H[Fetch Nearest Prices]
  H --> I[Calculate Approximate Price]
  I --> F
  B --> J[Bull Queue]
  J --> K[Scheduled Daily Fetcher]
  K --> L[Get Token Creation Date]
  L --> M[Generate Daily Timestamps]
  M --> N[Batch Alchemy Requests]
  N --> O[Persist to DB]
  P[OneRender Daemon] --> Q[Monitors Redis]
  Q --> R[Triggers Backfill for Missing Data]
🔥 Additional Features
📈 Interactive Price Graph
Visualizes token price trends for 1 Day, 1 Week, 1 Month, and All Time using chart components.

🕓 Recently Active Queries
Displays your last 4 looked-up tokens. Click to instantly re-fetch and display results.

🧠 Autonomous Price Crawler
A background service (deployed via OneRender) continuously monitors Redis for cache misses and fills in missing historical data.

📦 Folder Structure
bash
Copy
Edit
├── src/
│   ├── pages/              # Next.js routes
│   ├── components/         # Reusable components (e.g., Graph, RecentQueries)
│   ├── lib/                # Redis & DB connection
│   ├── api/                # Express API routes
│   ├── worker/             # BullMQ worker
│   ├── utils/              # Interpolation logic, helpers
├── public/
├── .env
├── redisConnect.ts
├── priceWorker.ts
🧪 API Endpoints
GET /price
Returns the historical price or interpolated value.

json
Copy
Edit
{
  "token": "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "network": "ethereum",
  "timestamp": 1678901234
}
Response:

json
Copy
Edit
{
  "price": 0.9998,
  "source": "cache" | "alchemy" | "interpolated"
}
POST /schedule
Schedules a job to fetch daily prices from the token’s creation date to now.

json
Copy
Edit
{
  "token": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  "network": "polygon"
}
🧠 Interpolation Logic
python
Copy
Edit
def interpolate(ts_q, ts_before, price_before, ts_after, price_after):
  ratio = (ts_q - ts_before) / (ts_after - ts_before)
  return price_before + (price_after - price_before) * ratio
🏗️ Setup Instructions
1. Clone the Repository
bash
Copy
Edit
git clone https://github.com/yourusername/token-price-oracle.git
cd token-price-oracle
2. Install Dependencies
bash
Copy
Edit
npm install
3. Configure Environment Variables
Create a .env file:

env
Copy
Edit
MONGODB_URI=your_mongodb_connection_string
REDIS_URL=redis://localhost:6379
ALCHEMY_API_KEY_ETHEREUM=your_alchemy_ethereum_key
ALCHEMY_API_KEY_POLYGON=your_alchemy_polygon_key
4. Run Locally
bash
Copy
Edit
# Start Next.js frontend + Express API
npm run dev

# Start the background job worker
npm run worker
