import type { Theme } from './store';

export const THEME_OPTIONS: { id: Theme; label: string; bg: string; primary?: string; split?: boolean; group: 'auto' | 'light' | 'dark' }[] = [
  { id: 'system', label: 'Auto', group: 'auto', bg: 'linear-gradient(135deg, #ffffff 50%, #242426 50%)', split: true },
  { id: 'light', group: 'light', label: 'Light', bg: '#ffffff', primary: '#34745c' },
  { id: 'dark', group: 'dark', label: 'Dark', bg: '#242426', primary: '#85bda3' },
  { id: 'white', group: 'light', label: 'Porcelain', bg: '#ffffff', primary: '#2f6fed' },
  { id: 'midnight', group: 'dark', label: 'Midnight', bg: '#151e30', primary: '#9bbcff' },
  { id: 'slate', group: 'light', label: 'Slate', bg: '#eef0f5', primary: '#5b6ee8' },
  { id: 'forest', group: 'dark', label: 'Forest', bg: '#202723', primary: '#85bda3' },
  { id: 'sepia', group: 'light', label: 'Sepia', bg: '#f6efe2', primary: '#9c6b2e' },
  { id: 'ember', group: 'dark', label: 'Ember', bg: '#2c211b', primary: '#f0b387' },
  { id: 'graphite', group: 'dark', label: 'Plum', bg: '#281e2c', primary: '#e2afe0' },
  { id: 'rose', group: 'light', label: 'Rose', bg: '#faf1f4', primary: '#a74669' },
  { id: 'mist', group: 'light', label: 'Mist', bg: '#edf6f8', primary: '#276779' },
  { id: 'deep-teal', group: 'dark', label: 'Deep Teal', bg: '#14282a', primary: '#82cfc6' },
];
