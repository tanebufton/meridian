import { Routes, Route } from 'react-router-dom';
import LeftSidebar from './components/LeftSidebar';
import Overview from './pages/Overview';
import GroupView from './pages/GroupView';
import TargetDetail from './pages/TargetDetail';

export default function App() {
  return (
    <div className="app-shell">
      <LeftSidebar />
      <div className="content-area">
        <div className="content-inner">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/group/:id" element={<GroupView />} />
            <Route path="/target/:id" element={<TargetDetail />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
