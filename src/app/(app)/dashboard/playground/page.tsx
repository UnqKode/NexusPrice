"use client";
import React, { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { motion } from "framer-motion";

const Page = () => {
  const [currentPrice, setCurrentPrice] = useState("0.00");
  const [TimeStampPrice, setTimeStampPrice] = useState("0.00");
  const [tokenAddress, setTokenAddress] = useState("");
  const [network, setNetwork] = useState("");
  const [startTime, setStartTime] = useState("");
  const [fetchHistory, setFetchHistory] = useState<
    { coinId: string; network: string; timestamp: string }[]
  >([]);

  useEffect(() => {
    const historyRaw = localStorage.getItem("fetchHistory");
    if (historyRaw) {
      setFetchHistory(JSON.parse(historyRaw));
    }
  }, []);

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

    toast.loading("Fetching price data...");
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
        setCurrentPrice(data.Current?.price ?? "0.00");
        setTimeStampPrice(data.History?.price ?? "0.00");
        toast.success("Price data fetched successfully");
        setTimeout(() => {
          if (data.History?.method) {
            toast.info("Fetch through: " + data.History?.method);
          } else {
            toast.info(data.message || "Enter correct value");
          }
        }, 2000);
      } else {
        toast.error(data.message || "Failed to fetch price data");
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
    e.preventDefault(); // Prevent default form submission
    onFetchPriceData(); // Call the data fetching function

    const newEntry = {
      coinId: tokenAddress,
      network: network,
      timestamp: startTime,
    };
    if (tokenAddress && network && startTime) {
      const updatedHistory = [...fetchHistory, newEntry].slice(-4);
      localStorage.setItem("fetchHistory", JSON.stringify(updatedHistory));
      setFetchHistory(updatedHistory);
    }
  };

  function calculatePercentageChange(
    oldPrice: number,
    newPrice: number
  ): number {
    if (oldPrice === 0) return 0; // avoid division by zero
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
          <h2 className="text-3xl font-bold text-white">Price Overview</h2>
          <div className="flex gap-2">
            {/* Schedule Full History Button */}
            <button
              type="button"
              onClick={ScheduleFullHistory} // Use onClick for web
              className="mt-6 px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded-md text-white transition-colors text-sm font-medium"
            >
              Schedule Full History
            </button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="py-5">
          <h3 className="text-lg font-semibold text-white mb-4">
            Add Token Data
          </h3>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Horizontal Fields */}
            <div className="flex flex-col md:flex-row md:items-end md:gap-4 space-y-4 md:space-y-0">
              {/* Token Address */}
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

              {/* Network */}
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

              {/* Start Time */}
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

              {/* Submit */}
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
          {/* Timestamp Price Card */}
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
              ${TimeStampPrice?.toLocaleString() || "--"}
            </p>
            <p className="text-xs text-indigo-400/80">
              Price at selected timestamp
            </p>
          </motion.div>

          {/* Current Price Card */}
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
              ${currentPrice?.toLocaleString() || "--"}
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

          {/* Change Card */}
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

        {/* Chart Placeholder */}

        {/* Recent Activity */}
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
                <div className="flex justify-between">
                  <p className="text-white">
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
