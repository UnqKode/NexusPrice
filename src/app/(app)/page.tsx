"use client";

import React from "react";
import { motion } from "framer-motion";
import Nav from "@/components/Nav";
import { toast } from "sonner";
import { FiTrendingUp, FiDatabase, FiCode, FiBarChart2 } from "react-icons/fi";

const Page = () => {
  
  const features = [
    {
      icon: <FiDatabase className="text-3xl mb-4 text-indigo-400" />,
      title: "Historical Price Data",
      description: "Access precise token prices for any point in time with our comprehensive database."
    },
    {
      icon: <FiTrendingUp className="text-3xl mb-4 text-indigo-400" />,
      title: "Smart Interpolation",
      description: "Get accurate estimates even when exact prices are not available."
    },
    {
      icon: <FiBarChart2 className="text-3xl mb-4 text-indigo-400" />,
      title: "Custom Token Graphs",
      description: "Visualize price trends for any ERC20 token with our interactive charting tools."
    },
    {
      icon: <FiCode className="text-3xl mb-4 text-indigo-400" />,
      title: "Developer Friendly",
      description: "Simple API integration with clear documentation for easy implementation."
    }
  ];

  return (
    <>
      <Nav />
      <div className="w-full relative overflow-hidden bg-black">
        {/* Hero Section */}
        <div className="h-screen relative">
          <motion.img
            src="/assets/images/home.jpg"
            alt="Background"
            initial={{ opacity: 0, scale: 1.05 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1.5, ease: "easeOut" }}
            className="absolute inset-0 w-full h-full object-cover"
          />

          <div className="absolute inset-0 bg-black/60 z-10" />

          <div className="relative z-20 h-full flex items-center justify-start px-6 md:px-20 text-white">
            <div className="max-w-xl">
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8, duration: 0.7 }}
                className="text-4xl md:text-6xl font-bold mb-4 tracking-wider"
              >
                Nexus Price
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.1, duration: 0.7 }}
                className="text-lg md:text-xl text-gray-200 mb-6"
              >
                Get accurate historical token prices with powerful interpolation.
              </motion.p>

              <motion.div
                className="flex gap-4"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.4, duration: 0.6 }}
              >
                <motion.a
                  href="/dashboard/playground"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-lg font-semibold shadow-lg transition-all"
                >
                  Try for Free Now
                </motion.a>

                <motion.a
                  onClick={(e) => {
                    e.preventDefault();
                    toast.error("Not so fast ,This feature is under development!");
                  }}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  href="#"
                  className="bg-white text-indigo-600 hover:bg-gray-200 px-6 py-3 rounded-lg font-semibold shadow-lg transition-all cursor-pointer"
                >
                  Sign Up
                </motion.a>
              </motion.div>
            </div>
          </div>
        </div>

        {/* Features Section */}
        <div className="py-20 px-6 md:px-20 bg-gradient-to-b from-gray-900 to-black">
          <motion.div 
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="max-w-6xl mx-auto"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white text-center mb-12">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400">
                Powerful Features
              </span>
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
              {features.map((feature, index) => (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1, duration: 0.5 }}
                  viewport={{ once: true }}
                  className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-xl border border-gray-700 hover:border-indigo-500 transition-colors text-center"
                >
                  {feature.icon}
                  <h3 className="text-xl font-semibold text-white mb-2">{feature.title}</h3>
                  <p className="text-gray-400">{feature.description}</p>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Graph Visualization Section */}
          <div className="mt-20 max-w-6xl mx-auto">
            <motion.div
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              transition={{ duration: 0.8 }}
              viewport={{ once: true }}
              className="bg-gray-800/30 backdrop-blur-lg rounded-xl border border-gray-700 p-8"
            >
              <div className="flex flex-col md:flex-row items-center gap-8">
                <div className="md:w-1/2">
                  <h3 className="text-2xl font-bold text-white mb-4">
                   Token Price History
                  </h3>
                  <p className="text-gray-300 mb-6">
                    Plot comprehensive price graphs for any ERC20 token across multiple timeframes. 
                    Our intuitive interface lets you analyze price trends from token creation to present day.
                  </p>
                  <ul className="space-y-3 text-gray-400">
                    <li className="flex items-start">
                      <span className="text-indigo-400 mr-2">•</span>
                      Compare performance across different time periods
                    </li>
                    <li className="flex items-start">
                      <span className="text-indigo-400 mr-2">•</span>
                      Identify key support and resistance levels
                    </li>
                    <li className="flex items-start">
                      <span className="text-indigo-400 mr-2">•</span>
                      Export data for your own analysis
                    </li>
                  </ul>
                  <motion.a
                    href="/dashboard/stats"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="mt-6 inline-block px-6 py-3 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-white font-medium transition-colors"
                  >
                    Start Graphing Now
                  </motion.a>
                </div>
                <div className="md:w-1/2 bg-gray-900/50 rounded-lg p-4 border border-gray-700">
                  <div className="aspect-video bg-gradient-to-br from-indigo-900/20 to-purple-900/20 rounded-lg flex items-center justify-center">
                    <div className="text-center p-6">
                      <FiBarChart2 className="mx-auto text-5xl text-indigo-400 mb-4" />
                      <h4 className="text-xl font-semibold text-white mb-2">
                        Interactive Token Charts
                      </h4>
                      <p className="text-gray-400">
                        Enter any token address to generate detailed price visualizations
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="py-20 px-6 bg-gradient-to-b from-black to-gray-900">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="max-w-4xl mx-auto text-center"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-6">
              Ready to explore token price history?
            </h2>
            <p className="text-xl text-gray-300 mb-8">
              Join hundreds of developers and analysts using NexusPrice for accurate token data.
            </p>
            <motion.a
              href="/dashboard/playground"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="inline-block px-8 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white rounded-lg font-medium transition-all transform hover:scale-105 shadow-lg"
            >
              Get Started Now
            </motion.a>
          </motion.div>
        </div>
      </div>
    </>
  );
};

export default Page;