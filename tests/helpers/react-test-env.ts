import { JSDOM } from 'jsdom';
import React from 'react';

const installedGlobals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Event',
  'MutationObserver',
  'getComputedStyle',
  'React',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

export function installReactTestEnvironment(): () => void {
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const name of installedGlobals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  const values: Record<(typeof installedGlobals)[number], unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const name of installedGlobals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: values[name],
    });
  }

  return () => {
    dom.window.close();
    for (const name of installedGlobals) {
      const descriptor = previous.get(name);
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<PropertyKey, unknown>)[name];
      }
    }
  };
}
