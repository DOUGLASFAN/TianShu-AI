import {useSyncExternalStore} from 'react';

const mobileLayoutQuery = '(max-width: 800px), (max-width: 1000px) and (max-height: 500px) and (pointer: coarse)';

export function isMobileLayout() {
  return window.matchMedia(mobileLayoutQuery).matches;
}

function subscribeToMobileLayout(callback: () => void) {
  const media = window.matchMedia(mobileLayoutQuery);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribeToMobileLayout, isMobileLayout);
}

export function focusMobilePanel(panel: HTMLElement | null) {
  if (!panel || !isMobileLayout()) return;
  panel.scrollIntoView({block: 'start'});
  panel.focus({preventScroll: true});
}
