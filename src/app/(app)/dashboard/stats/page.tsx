"use client";
import React, { useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { FiRefreshCw, FiExternalLink } from "react-icons/fi";
import Link from "next/link";

interface TooltipPayloadItem {
  value: number;
  [key: string] : string | number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
}
interface PriceItem {
  price: string;  // or number if the API returns numbers
  date?: string;  // add other fields as needed
}

interface ChartDataPoint {

  date: string;
  value: number;
}




const HistoricalPriceChart = () => {
  const [tokenAddress, setTokenAddress] = useState("");
  const [network, setNetwork] = useState("");
  const [loading, setLoading] = useState(false);
  const [chartData, setChartData] = useState<ChartDataPoint[] >([]);
  const [timeRange, setTimeRange] = useState("1w");
  const [priceRange, setPriceRange] = useState({ min: 0, max: 0 });

  const timeRanges = [
    { label: "1W", value: "1w" },
    { label: "1M", value: "1m" },
    { label: "3M", value: "3m" },
    { label: "6M", value: "6m" },
    { label: "1Y", value: "1y" }
  ];

const fetchHistoricalData = async () => {
  if (!tokenAddress || !network) {
    toast.error("Token address and network are required");
    return;
  }

  setLoading(true);
  const toastId = toast.loading("Fetching historical data..."); // store toast ID

  try {
    const response = await axios.post("/api/historical-prices", {
      tokenAddress,
      network,
      timeRange,
    });

    const { data } = response;
    if (data.success) {
      const prices = data.data.map((item: PriceItem) => parseFloat(item.price));
      setPriceRange({
        min: Math.min(...prices),
        max: Math.max(...prices),
      });
      prepareChartData(data.data);
      toast.success("Historical data loaded", { id: toastId }); // update toast
    } else {
      toast.error(data.message || "Failed to fetch data", { id: toastId }); // update toast
    }
  } catch (error) {
    console.error("Error:", error);
    toast.error("Error fetching data", { id: toastId }); // update toast
  } finally {
    setLoading(false);
  }
};


  const prepareChartData = (prices: { date: string; price: number }[]) => {
    const formattedData = prices.map((item) => ({
      date: new Date(item.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      value: item.price,
    }));
    setChartData(formattedData);
  };

  const CustomTooltip: React.FC<CustomTooltipProps> = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-gray-300">{label}</p>
          <p className="text-xl font-bold text-indigo-400">
           ${Number(payload[0].value).toFixed(4)}

          </p>
          <p className="text-xs text-gray-400 mt-1">
            {((payload[0].value - priceRange.min) / (priceRange.max - priceRange.min) * 100).toFixed(2)}% of range
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-gradient-to-br from-gray-900/50 to-gray-900/30 backdrop-blur-lg rounded-xl border border-gray-700/50 p-6 shadow-xl">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-300 to-purple-400">
            Token Price History
          </h2>
          <p className="text-sm text-gray-400">
            Visualize historical price data for any ERC20 token
          </p>
        </div>
        <button
          onClick={fetchHistoricalData}
          disabled={loading}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
            loading
              ? "bg-gray-700 text-gray-400"
              : "bg-indigo-600/90 hover:bg-indigo-700 text-white"
          }`}
        >
          {loading ? (
            <FiRefreshCw className="animate-spin" />
          ) : (
            <FiRefreshCw />
          )}
          Refresh Data
        </button>
      </div>

    
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-300">
            Token Address
          </label>
          <div className="relative">
            <input
              type="text"
              placeholder="0x..."
              className="w-full bg-gray-800/70 border border-gray-700/50 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-300">
            Network
          </label>
          <div className="relative">
            <select
              className="w-full bg-gray-800/70 border border-gray-700/50 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 appearance-none transition-all"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            >
              <option value="">Select network</option>
              <option value="ethereum">Ethereum</option>
              <option value="polygon">Polygon</option>
              <option value="arbitrum">Arbitrum</option>
              <option value="optimism">Optimism</option>
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-gray-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-300">
            Time Range
          </label>
          <div className="flex gap-2">
            {timeRanges.map((range) => (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                  timeRange === range.value
                    ? "bg-indigo-600/90 text-white shadow-md"
                    : "bg-gray-800/50 text-gray-300 hover:bg-gray-700/50"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
      </div>

  
      <div className="mt-6 h-[400px] relative">
        {chartData.length > 0 ? (
          <>
            <div className="absolute top-0 right-0 z-10 flex gap-2">
              <div className="bg-gray-800/70 border border-gray-700/50 rounded-lg px-3 py-1.5 text-xs text-gray-300">
                Min: ${priceRange.min.toFixed(4)}
              </div>
              <div className="bg-gray-800/70 border border-gray-700/50 rounded-lg px-3 py-1.5 text-xs text-gray-300">
                Max: ${priceRange.max.toFixed(4)}
              </div>
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
              >
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#818cf8" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0.2} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.5} />
                <XAxis 
                  dataKey="date" 
                  stroke="#9CA3AF" 
                  tick={{ fontSize: 12 }}
                  tickMargin={10}
                />
                <YAxis 
                  stroke="#9CA3AF" 
                  tickFormatter={(value) => `$${value.toFixed(2)}`}
                  width={80}
                />
                <Tooltip 
                  content={<CustomTooltip />} 
                  cursor={{ fill: 'rgba(99, 102, 241, 0.1)' }}
                />
                <Bar 
                  dataKey="value" 
                  fill="url(#colorValue)" 
                  radius={[6, 6, 0, 0]}
                  animationDuration={1500}
                />
              </BarChart>
            </ResponsiveContainer>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center bg-gray-900/30 rounded-xl border border-dashed border-gray-700/50">
            <div className="text-center p-6 max-w-md">
              <div className="text-gray-400 mb-4">
                <svg className="w-16 h-16 mx-auto opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-300 mb-2">
                No Data Available
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                Enter a token address and select a network to view historical price data
              </p>
              <button
                onClick={fetchHistoricalData}
                disabled={!tokenAddress || !network}
                className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                  !tokenAddress || !network
                    ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                    : "bg-indigo-600/90 hover:bg-indigo-700 text-white"
                }`}
              >
                Load Data
              </button>
            </div>
          </div>
        )}
      </div>

    
      {chartData.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-4 justify-between items-center text-sm text-gray-400">
          <div>
            Showing {chartData.length} data points for {tokenAddress.slice(0, 6)}...{tokenAddress.slice(-4)}
          </div>
          <Link  
            href={`https://etherscan.io/token/${tokenAddress}`} 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            View on Etherscan <FiExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  );
};

export default HistoricalPriceChart;