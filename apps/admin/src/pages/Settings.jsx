import { useSearchParams } from 'react-router-dom';
import General from './settings/General';
import Alerting from './settings/Alerting';
import Account from './settings/Account';
import Users from './settings/Users';
import Data from './settings/Data';
import Audit from './settings/Audit';

const TABS = [
  { id: 'general', label: 'General', C: General },
  { id: 'alerting', label: 'Alerting', C: Alerting },
  { id: 'account', label: 'My account', C: Account },
  { id: 'users', label: 'Users', C: Users },
  { id: 'data', label: 'Data', C: Data },
  { id: 'audit', label: 'Audit log', C: Audit },
];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const active = TABS.find((t) => t.id === params.get('tab')) || TABS[0];
  const Active = active.C;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active.id}
            className={`tab${t.id === active.id ? ' active' : ''}`}
            onClick={() => setParams(t.id === 'general' ? {} : { tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  );
}
