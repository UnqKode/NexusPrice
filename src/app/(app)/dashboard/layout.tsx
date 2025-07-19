'use client';
import { usePathname, useRouter } from 'next/navigation';
import React, { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

const DashboardLayout = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();

  const lastSegment = pathname.split('/').filter(Boolean).pop();

  const navItems = [
    {
      label: 'Dashboard',
      icon: DashboardIcon,
      path: '/dashboard/playground',
      slug: 'playground',
    },
    {
      label: 'Analytics',
      icon: AnalyticsIcon,
      path: '/dashboard/stats',
      slug: 'stats',
    },
    {
      label: 'Settings',
      icon: SettingsIcon,
      path: '',
      slug: 'settings',
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="bg-gradient-to-br from-gray-900 via-black to-gray-900 h-screen flex"
    >
      {/* Sidebar */}
      <motion.div
        initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
        transition={{ type: 'spring', stiffness: 100 }}
        className="bg-white/10 backdrop-blur-lg p-6 w-64 hidden md:block border-r border-gray-800"
      >
        <motion.div 
          whileHover={{ scale: 1.02 }}
          className="flex items-center gap-3 mb-8 cursor-pointer"
          onClick={() => router.replace('/')}
        >
          <motion.div 
            whileHover={{ rotate: 15 }}
            className="w-8 h-8 bg-indigo-500/90 rounded-full flex items-center justify-center shadow-md"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              className="w-4 h-4 text-white"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </motion.div>
          <h1 className="text-xl font-bold text-white">NexusPrice</h1>
        </motion.div>

        <nav className="space-y-2">
          {navItems.map(({ label, icon: Icon, path, slug }) => (
            <motion.button
              key={label}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                if(!path){
                  toast.error("This section is under development!");
                  return;
                } 
                router.replace(path)
              }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors ${
                lastSegment === slug
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <motion.span
                animate={{ 
                  rotate: lastSegment === slug ? [0, 10, -5, 0] : 0,
                  scale: lastSegment === slug ? [1, 1.1, 1] : 1
                }}
                transition={{ duration: 0.5 }}
              >
                <Icon />
              </motion.span>
              <motion.span
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                {label}
              </motion.span>
            </motion.button>
          ))}
        </nav>
      </motion.div>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        <AnimatePresence mode="wait">
           <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            transition={{ 
              duration: 1,
              ease: [0.22, 1, 0.36, 1] // Smooth easing curve
            }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

// ... (keep your existing icon components)

export default DashboardLayout;


const DashboardIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-5 w-5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 12l-5.5 2.5a2 2 0 01-1.5 0L6 12M19 12c0-.53-.35-1.01-.88-1.87L14.5 4.7C13.4 3 12.8 2 12 2s-1.4 1-2.5 2.7L5.88 10.13C5.35 11 5 11.47 5 12M19 12c0 .53-.35 1.01-.88 1.87L14.5 19.3C13.4 21 12.8 22 12 22s-1.4-1-2.5-2.7L5.88 13.87C5.35 13 5 12.53 5 12" />
  </svg>
);

const AnalyticsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-5 w-5"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <path
      fillRule="evenodd"
      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2h-1V9z"
      clipRule="evenodd"
    />
  </svg>
);

const SettingsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-5 w-5"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <path
      fillRule="evenodd"
      d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
      clipRule="evenodd"
    />
  </svg>
);