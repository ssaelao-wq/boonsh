// Ten tab header colors, far apart in hue so neighbouring tabs are easy to tell apart. All are dark enough for
// white text. New tabs take them in turn (see `newTab` in App.tsx); the tab menu lets the user pick any of them.
export const TAB_COLORS = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#ea580c', // orange
  '#9333ea', // purple
  '#0d9488', // teal
  '#db2777', // pink
  '#b45309', // brown
  '#4f46e5', // indigo
  '#0891b2', // cyan
];

export const tabColor = (n: number) => TAB_COLORS[n % TAB_COLORS.length];
