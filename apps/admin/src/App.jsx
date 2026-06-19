import { Routes, Route, Navigate } from 'react-router-dom';
import { useMe } from './hooks/useApi';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import AdminDashboard from './pages/AdminDashboard';
import Targets from './pages/Targets';
import Groups from './pages/Groups';
import Settings from './pages/Settings';

function ProtectedLayout() {
  const { data, isLoading, isError } = useMe();

  if (isLoading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}><div className="spinner" /></div>;
  if (isError) return <Navigate to="/login" replace />;

  return (
    <div className="layout">
      <Sidebar username={data.username} />
      <main className="main">
        <Routes>
          <Route path="/" element={<AdminDashboard />} />
          <Route path="/targets" element={<Targets />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<ProtectedLayout />} />
    </Routes>
  );
}
