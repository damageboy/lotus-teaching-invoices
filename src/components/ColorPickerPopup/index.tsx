import { useState, useEffect, useRef } from 'react';
import { HexColorPicker } from 'react-colorful';
import { PALETTE_HEX, studioColor } from '../../lib/studioColors';

interface Props {
  currentColor: string;
  onColorChange: (hex: string) => void;
  onClose: () => void;
}

type Tab = 'swatches' | 'radial';

export function ColorPickerPopup({ currentColor, onColorChange, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('swatches');
  const [radialColor, setRadialColor] = useState(currentColor);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click-outside
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  function handleSwatchClick(hex: string) {
    onColorChange(hex);
    onClose();
  }

  function handleRadialChange(hex: string) {
    setRadialColor(hex);
    onColorChange(hex);
  }

  return (
    <div
      ref={containerRef}
      className="absolute z-50 mt-1 bg-white rounded-lg border border-gray-200 shadow-lg p-3 w-52"
      style={{ top: '100%', left: 0 }}
    >
      {/* Tab bar */}
      <div className="flex gap-1 mb-3 border-b border-gray-100 pb-2">
        {(['swatches', 'radial'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`text-xs px-2 py-0.5 rounded capitalize ${
              activeTab === tab
                ? 'bg-gray-100 text-gray-800 font-medium'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Swatches tab */}
      {activeTab === 'swatches' && (
        <div className="flex flex-wrap gap-2 justify-center">
          {PALETTE_HEX.map((hex) => {
            const isActive = hex.toLowerCase() === currentColor.toLowerCase();
            return (
              <button
                key={hex}
                onClick={() => handleSwatchClick(hex)}
                title={hex}
                style={{ backgroundColor: hex }}
                className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
                  isActive ? 'border-gray-800 scale-110' : 'border-transparent'
                }`}
              />
            );
          })}
        </div>
      )}

      {/* Radial tab */}
      {activeTab === 'radial' && (
        <div className="flex flex-col gap-2">
          <HexColorPicker
            color={radialColor}
            onChange={handleRadialChange}
            style={{ width: '100%', height: 160 }}
          />
          <div className="flex items-center gap-2 mt-1">
            <div
              className="w-5 h-5 rounded border border-gray-200 flex-shrink-0"
              style={{ backgroundColor: radialColor }}
            />
            <span className="text-xs font-mono text-gray-500">{radialColor}</span>
          </div>
        </div>
      )}
    </div>
  );
}
