import { Link } from 'react-router-dom';

export default function Header() {
  return (
    <header className="header">
      <Link to="/" style={{ textDecoration: 'none' }}>
        <span className="header-logo">Meridian</span>
      </Link>
      <span className="header-sub">Network Monitor</span>
    </header>
  );
}
