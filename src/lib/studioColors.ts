export const PALETTE_HEX = [
  '#7c3aed', // violet
  '#0284c7', // sky
  '#059669', // emerald
  '#d97706', // amber
  '#e11d48', // rose
  '#0d9488', // teal
];

function hashString(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

export function studioColor(
  name: string,
  hex?: string
): { backgroundColor: string; color: string; borderColor: string } {
  const baseHex = hex ?? PALETTE_HEX[hashString(name) % PALETTE_HEX.length];
  const [h, s] = hexToHsl(baseHex);
  return {
    backgroundColor: `hsl(${h}, ${s}%, 93%)`,
    color: `hsl(${h}, ${s}%, 25%)`,
    borderColor: `hsl(${h}, ${s}%, 70%)`,
  };
}

export function nextUnusedColor(usedHexes: string[]): string {
  const used = new Set(usedHexes.map((h) => h.toLowerCase()));
  return PALETTE_HEX.find((h) => !used.has(h)) ?? PALETTE_HEX[0];
}
