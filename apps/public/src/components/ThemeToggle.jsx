import { useState } from 'react';

const KEY = 'meridian_theme';
const ORDER = ['dark', 'light', 'auto'];
const ICON = { dark: '☾ Dark', light: '☀ Light', auto: '◐ Auto' };

export function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
}

export function initialTheme() {
  try { const t = localStorage.getItem(KEY); if (ORDER.includes(t)) return t; } catch { /* storage blocked */ }
  return 'dark';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(initialTheme);
  function next() {
    const n = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(n); applyTheme(n);
    try { localStorage.setItem(KEY, n); } catch { /* storage blocked */ }
  }
  return <button className="theme-btn" onClick={next} title="Switch theme (dark / light / follow system)">{ICON[theme]}</button>;
}
