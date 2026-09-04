"use client";
import React, { useState, useSyncExternalStore } from "react";
import axios from "axios";
import { toast } from "sonner";
import { motion } from "framer-motion";

interface HistoryEntry {
  coinId: string;
  network: string;
  timestamp: string;
}

// localStorage is an external store, so it's read through useSyncExternalStore
// rather than a useState + useEffect pair. Reading it in an effect and calling
// setState synchronously renders once with an empty list and then immediately
// re-renders with the real one - the cascading render that
// react-hooks/set-state-in-effect flags. Subscribing to "storage" also keeps
// two open tabs in agreement, which the effect version never did.
const HISTORY_KEY = "fetchHistory";
const HISTORY_LIMIT = 4;
const EMPTY_HISTORY: HistoryEntry[] = [];

const historyListeners = new Set<() => void>();
// getSnapshot must return a referentially stable value between renders or
// useSyncExternalStore re-renders forever, so the parsed array is memoized
// against the raw string it came from rather than re-parsed on every call.
let cachedRaw: string | null = null;
let cachedHistory: HistoryEntry[] = EMPTY_HISTORY;

function readHistory(): HistoryEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(HISTORY_KEY);
  } catch {
    return EMPTY_HISTORY; // private mode / storage disabled
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      cachedHistory = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : EMPTY_HISTORY;
    } catch {
      cachedHistory = EMPTY_HISTORY; // corrupt entry, treat as empty
    }
  }
  return cachedHistory;
}

function subscribeToHistory(onStoreChange: () => void): () => void {
  historyListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    historyListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

// There is no localStorage during SSR - the server always renders an empty
// list, and the real one arrives on the first client render.
function getServerHistory(): HistoryEntry[] {
  return EMPTY_HISTORY;
}

function writeHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded or storage disabled - nothing to recover, and the
    // lookup itself already succeeded, so this shouldn't surface an error.
  }
  cachedRaw = null; // force the next getSnapshot to re-read
  historyListeners.forEach((notify) => notify());
}

const Page = () => {
  const [currentPrice, setCurrentPrice] = useState("0.00");
  const [TimeStampPrice, setTimeStampPrice] = useState("0.00");
  const [tokenAddress, setTokenAddress] = useState("");
  const [network, setNetwork] = useState("");
  const [startTime, setStartTime] = useState("");
  const fetchHistory = useSyncExternalStore(
    subscribeToHistory,
    readHistory,
    getServerHistory
  );

  const onFetchPriceData = async () => {
    if (!tokenAddress) {
      toast.error("Token address is required");
      return;
    }

    if (!network) {
      toast.error("Network is required");
      return;
    }

    if (!startTime) {
      toast.error("Start Time is required");
      return;
    }

    const startUnix = Math.floor(new Date(startTime).getTime() / 1000);

    const id = toast.loading("Fetching price data...");
    console.log("Fetching price data for:", {
      tokenAddress,
      network,
      startUnix,
    });

    try {
      const res = await axios.post("/api/price", {
        coinId: tokenAddress,
        network,
        startTime: startUnix,
      });

      const { data } = res;

      if (data.success) {
        console.log("Price data fetched successfully:", data);

        const historyPriceNum = data.History?.price;

        

        const historyPriceStr =
          typeof historyPriceNum === "number"
            ? historyPriceNum.toFixed(12)
            : "0.00";

        console.log("Historical price:", historyPriceStr);

        setCurrentPrice(data.Current?.price ?? "0.00");
        setTimeStampPrice(historyPriceStr);

        toast.success("Price data fetched successfully", { id: id });

        setTimeout(() => {
          if (data.History?.method) {
            toast.info("Fetch through: " + data.History?.method);
          } else {
            toast.info(data.message || "Enter correct value");
          }
        }, 2000);
      } else {
        toast.error(data.message || "Failed to fetch price data", { id: id });
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("An unknown error occurred");
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onFetchPriceData();
    const newEntry = {
      coinId: tokenAddress,
      network: network,
      timestamp: startTime,
    };
    if (tokenAddress && network && startTime) {
      writeHistory([...fetchHistory, newEntry].slice(-HISTORY_LIMIT));
    }
  };

  // The two price values are held as strings (and Current can arrive from the
  // API as a number), and the display previously called `.toLocaleString()`
  // directly on them - a no-op on a string, and a lossy 3-decimal round on a
  // number, which rendered a $0.000021 token as "$0". This formats by
  // magnitude so both large and sub-cent token prices read correctly.
  const formatPrice = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined || value === "") return "--";
    const num = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(num)) return "--";
    if (num === 0) return "0.00";
    if (num >= 1) return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (num >= 0.01) return num.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return num.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 8 });
  };

  function calculatePercentageChange(
    oldPrice: number,
    newPrice: number
  ): number {
    if (oldPrice === 0) return 0;
    return ((newPrice - oldPrice) / oldPrice) * 100;
  }

  const percentageChange = calculatePercentageChange(
    parseFloat(TimeStampPrice),
    parseFloat(currentPrice)
  );

  const ScheduleFullHistory = async () => {
    try {
      if (!tokenAddress) {
        toast.error("Token address is required");
        return;
      }
      if (!network) {
        toast.error("Network is required");
        return;
      }
      toast.info(
        `Scheduling full history for ${tokenAddress} on ${network}...`
      );
      const res = await axios.post("/api/schedule", {
        coinId: tokenAddress,
        network,
      });
      if (res.data.success) {
        toast.success(res.data.message);
      } else {
        toast.error(res.data.message);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("An unknown error occurred");
      }
    }
  };

  const isIncrease = percentageChange >= 0;

  return (
    <div className="flex-1 h-screen">
      <div className="bg-white/5 backdrop-blur-lg rounded-xl border border-gray-800 p-6 ">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">
            Price Overview
          </h2>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <button
              type="button"
              onClick={ScheduleFullHistory}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded-md text-white transition-colors text-sm font-medium w-full sm:w-auto"
            >
              Schedule Full History
            </button>
          </div>
        </div>

        <div className="py-5">
          <h3 className="text-lg font-semibold text-white mb-4">
            Add Token Data
          </h3>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex flex-col md:flex-row md:items-end md:gap-4 space-y-4 md:space-y-0">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Token Address
                </label>
                <input
                  type="text"
                  placeholder="0x..."
                  className="w-full bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  onChange={(e) => setTokenAddress(e.target.value)}
                />
              </div>

              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Network
                </label>
                <select
                  className="w-full bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={network}
                  onChange={(e) => setNetwork(e.target.value)}
                >
                  <option value="">Select network</option>
                  <option value="ethereum">Ethereum</option>
                  <option value="polygon">Polygon</option>
                  <option value="arbitrum">Arbitrum</option>
                  <option value="optimism">Optimism</option>
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Start Time
                </label>
                <input
                  type="datetime-local"
                  className="w-full bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>

              <div>
                <button
                  type="submit"
                  className="mt-6 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-md text-white transition-colors text-sm font-medium"
                >
                  Fetch Price Data
                </button>
              </div>
            </div>
          </form>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 my-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-indigo-900/20 border border-indigo-800/50 rounded-xl p-5 backdrop-blur-sm hover:border-indigo-600/50 transition-all duration-300"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 bg-indigo-400 rounded-full"></div>
              <p className="text-xs font-medium text-indigo-300 uppercase tracking-wider">
                Timestamp Price
              </p>
            </div>
            <p className="text-3xl md:text-4xl font-bold text-white mb-1">
              ${formatPrice(TimeStampPrice)}
            </p>
            <p className="text-xs text-indigo-400/80">
              Price at selected timestamp
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-purple-900/20 border border-purple-800/50 rounded-xl p-5 backdrop-blur-sm hover:border-purple-600/50 transition-all duration-300"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 bg-purple-400 rounded-full"></div>
              <p className="text-xs font-medium text-purple-300 uppercase tracking-wider">
                Current Price
              </p>
            </div>
            <p className="text-3xl md:text-4xl font-bold text-white mb-1">
              ${formatPrice(currentPrice)}
            </p>
            <p className="text-xs text-purple-400/80">
              {new Date().toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className={`bg-gradient-to-br ${
              isIncrease
                ? "from-green-900/20 to-green-900/10"
                : "from-red-900/20 to-red-900/10"
            } border ${
              isIncrease ? "border-green-800/50" : "border-red-800/50"
            } rounded-xl p-5 backdrop-blur-sm hover:${
              isIncrease ? "border-green-600/50" : "border-red-600/50"
            } transition-all duration-300`}
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  isIncrease ? "bg-green-400" : "bg-red-400"
                }`}
              ></div>
              <p
                className={`text-xs font-medium ${
                  isIncrease ? "text-green-300" : "text-red-300"
                } uppercase tracking-wider`}
              >
                {isIncrease ? "Gain" : "Loss"} Since Timestamp
              </p>
            </div>
            <div className="flex items-end gap-2">
              <p
                className={`text-3xl md:text-4xl font-bold ${
                  isIncrease ? "text-green-400" : "text-red-400"
                } mb-1`}
              >
                {isIncrease ? "↑" : "↓"}{" "}
                {Math.abs(percentageChange)?.toFixed(2) || "--"}%
              </p>
              {percentageChange && (
                <p
                  className={`text-sm ${
                    isIncrease ? "text-green-400/70" : "text-red-400/70"
                  } mb-1.5`}
                >
                  ($
                  {Math.abs(
                    Number(currentPrice || 0) - Number(TimeStampPrice || 0)
                  ).toFixed(2)}
                  )
                </p>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Compared to timestamp price
            </p>
          </motion.div>
        </div>

        <div className="mb-8">
          <h3 className="text-lg font-semibold text-white mb-4">
            Recent Activity
          </h3>
          <div className="space-y-3">
            {fetchHistory.map((item, index) => (
              <button
                key={`${item.coinId}-${item.network}-${item.timestamp}-${index}`}
                className="w-full text-left bg-white/5 hover:bg-white/10 p-3 rounded-lg border border-gray-800 transition-colors"
                onClick={() => {
                  setTokenAddress(item.coinId);
                  setNetwork(item.network);
                  setStartTime(item.timestamp);
                  console.log("Selected item:", item);
                  onFetchPriceData();
                  console.log("Clicked:", item);
                }}
              >
                <div className="flex justify-between gap-5">
                  <p className="text-white overflow-hidden">
                    Token: <span className="text-blue-400">{item.coinId}</span>
                  </p>
                  <p className="text-gray-400 text-sm">
                    {new Date(item.timestamp).toLocaleString()}
                  </p>
                </div>
                <p className="text-gray-300 text-sm">Network: {item.network}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Page;
