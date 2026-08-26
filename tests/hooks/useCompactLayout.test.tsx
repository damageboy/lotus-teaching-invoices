import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
}

interface ControllableMediaQuery {
  setMatches(matches: boolean): void;
}

function installMatchMedia(initialMatches: boolean): ControllableMediaQuery {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: (_type: 'change', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'change', listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => media,
  });

  return {
    setMatches(nextMatches) {
      matches = nextMatches;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
afterAll(() => restoreDom());

const { useCompactLayout } = await import('../../src/hooks/useCompactLayout.js');

function Probe() {
  const compact = useCompactLayout();
  return <span>{compact ? 'mobile' : 'desktop'}</span>;
}

describe('useCompactLayout', () => {
  it('switches at the 767px media query', async () => {
    const media = installMatchMedia(false);
    render(<Probe />);
    expect(document.body.textContent).toContain('desktop');

    await act(() => media.setMatches(true));

    expect(document.body.textContent).toContain('mobile');
  });
});
