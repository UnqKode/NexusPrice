"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { FiMenu, FiX } from "react-icons/fi";
import Link from "next/link";

const Nav = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1 }}
      className="z-50 max-w-4xl md:hidden my-5 relative"
    >
      {/* Top Navigation Bar */}
      <div className="bg-black/80 border border-white/40 backdrop-blur-lg px-4 py-3 rounded-md shadow-lg flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-600 rounded-full flex items-center justify-center shadow-md">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              className="w-5 h-5 text-white"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
            </svg>
          </div>
          <span className="text-white text-lg font-semibold tracking-wide">
            Lexsu <span className="text-indigo-500">Price</span>
          </span>
        </div>

        {/* Hamburger / Close Icon */}
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="text-white p-2 rounded-md hover:bg-white/10 transition duration-200 sm:hidden"
        >
          {isMenuOpen ? <FiX className="w-6 h-6" /> : <FiMenu className="w-6 h-6" />}
        </button>
      </div>

      {/* Dropdown Menu */}
      {isMenuOpen && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="absolute top-full left-0 right-0 mt-2 bg-neutral-800 backdrop-blur-3xl border border-white/40 rounded-2xl shadow-xl"
        >
          <div className="flex flex-col p-3">
            {[
              { label: "Plaground", href: "/dashboard/playground" },
              { label: "Graphs", href: "/dashboard/stats" },
              { label: "Setting", href: "/" }   
            ].map(({ label, href }) => (
              <Link
                key={label}
                href={href}
                className="px-4 py-3 text-white hover:bg-indigo-500 rounded-lg transition"
              >
                {label}
              </Link>
            ))}

            <Link
              href="/dashboard/playground"
              className="mt-2 px-4 py-3 bg-indigo-600 text-white rounded-lg text-center hover:bg-indigo-700 transition"
            >
              Get Started
            </Link>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
};

export default Nav;
