'use client';

import React, { useState } from "react";
import { motion } from "framer-motion";
import { FiMenu, FiX } from "react-icons/fi";
import Link from "next/link";

const Nav = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <>
     
      <motion.nav
       initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 1 }}
        className="absolute top-5 left-1/2 transform -translate-x-1/2 z-50 w-[95%] max-w-4xl hidden md:block"
      >
        <div className="bg-white/80 border border-white/40 backdrop-blur-lg p-3.5 rounded-full shadow-lg">
          <div className="flex items-center justify-between px-6">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-8 h-8 bg-indigo-500/90 rounded-full flex items-center justify-center shadow-md group-hover:bg-indigo-600 transition-colors">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="w-4 h-4 text-white"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
                </svg>
              </div>
              <span className="text-lg font-semibold text-gray-800 group-hover:text-indigo-700 transition-colors">
                Nexus Price
              </span>
            </Link>

            <div className="flex items-center gap-1">
              <div  className="text-sm font-medium px-4 py-2 rounded-full hover:bg-white/30 text-gray-700 hover:text-gray-900 transition-all duration-200">
                Features
              </div>
              <div  className="text-sm font-medium px-4 py-2 rounded-full hover:bg-white/30 text-gray-700 hover:text-gray-900 transition-all duration-200">
                Pricing
              </div>
              <div  className="text-sm font-medium px-4 py-2 rounded-full hover:bg-white/30 text-gray-700 hover:text-gray-900 transition-all duration-200">
                API
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link href="" className="text-sm font-medium px-4 py-2 rounded-full hover:bg-white/40 text-gray-800 hover:text-gray-900 transition-all duration-200">
                Login
              </Link>
              <Link href="/dashboard/playground" className="text-sm font-medium px-4 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg transition-all duration-200">
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </motion.nav>

    
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1 }}
        className="absolute top-5 left-1/2 transform -translate-x-1/2 z-50 w-[95%] max-w-4xl md:hidden"
      >
        <div className="bg-white/30 border border-white/40 backdrop-blur-lg p-3 rounded-full shadow-lg">
          <div className="flex items-center justify-between px-4">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-8 h-8 bg-indigo-500/90 rounded-full flex items-center justify-center shadow-md">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="w-4 h-4 text-white"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
                </svg>
              </div>
              <span className="text-lg font-semibold text-gray-800">Nexus Price</span>
            </Link>

            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="p-2 rounded-full hover:bg-white/30 transition-colors"
              aria-label="Toggle menu"
            >
              {isMenuOpen ? <FiX className="w-5 h-5 text-gray-800" /> : <FiMenu className="w-5 h-5 text-gray-800" />}
            </button>
          </div>
        </div>

    
        {isMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="absolute top-full left-0 right-0 mt-2 bg-white/90 backdrop-blur-lg border border-white/40 rounded-2xl shadow-xl overflow-hidden"
          >
            <div className="flex flex-col p-2">
              <Link href="/" className="px-4 py-3 text-gray-800 hover:bg-indigo-50 rounded-lg transition-colors">
                Features
              </Link>
              <Link href="/" className="px-4 py-3 text-gray-800 hover:bg-indigo-50 rounded-lg transition-colors">
                Pricing
              </Link>
              <Link href="/" className="px-4 py-3 text-gray-800 hover:bg-indigo-50 rounded-lg transition-colors">
                API Documentation
              </Link>
              <div className="border-t border-gray-200 my-1"></div>
              <Link href="/" className="px-4 py-3 text-gray-800 hover:bg-indigo-50 rounded-lg transition-colors">
                Login
              </Link>
              <Link href="/dashboard/playground" className="px-4 py-3 bg-indigo-600 text-white rounded-lg text-center hover:bg-indigo-700 transition-colors">
                Get Started
              </Link>
            </div>
          </motion.div>
        )}
      </motion.div>
    </>
  );
};

export default Nav;
