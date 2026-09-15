import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { HashRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import ScrollToTop from './components/ScrollToTop';
import Home from '@/pages/Home';
import { AuthProvider } from './context/AuthContext';
import { SettingsProvider } from './lib/SettingsContext';
import ElectronCloseGuard from './components/ElectronCloseGuard';

function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
      <QueryClientProvider client={queryClientInstance}>
        <ElectronCloseGuard />
        <Router>
          <ScrollToTop />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </Router>
        <Toaster />
      </QueryClientProvider>
      </SettingsProvider>
    </AuthProvider>
  )
}

export default App