import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import LeftSidebar from './components/LeftSidebar';
import Overview from './pages/Overview';
import { useSummary } from './hooks/useApi';

// The chart library is the bulk of the bundle; only load it on pages that draw charts
const GroupView = lazy(() => import('./pages/GroupView'));
const TargetDetail = lazy(() => import('./pages/TargetDetail'));
const Incidents = lazy(() => import('./pages/Incidents'));

// Put the state of the world in the tab title, so a pinned tab works as a status light
function useTabTitle() {
  const { data } = useSummary();
  useEffect(() => {
    if (!data) { document.title = 'Meridian'; return; }
    const bad = data.offline;
    const warn = data.degraded;
    document.title = bad > 0 ? `(${bad} down) Meridian` : warn > 0 ? `(${warn} degraded) Meridian` : 'Meridian';
  }, [data]);
}

export default function App() {
  useTabTitle();
  const { pathname } = useLocation();
  // Return to the top on navigation (the content pane scrolls, not the window)
  useEffect(() => { document.querySelector('.content-area')?.scrollTo(0, 0); }, [pathname]);

  return (
    <div className="app-shell">
      <LeftSidebar />
      <div className="content-area">
        <div className="content-inner">
          <Suspense fallback={<div className="spinner" />}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/group/:id" element={<GroupView />} />
              <Route path="/target/:id" element={<TargetDetail />} />
              <Route path="/incidents" element={<Incidents />} />
              <Route path="*" element={<div className="error-state">Page not found.</div>} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </div>
  );
}
