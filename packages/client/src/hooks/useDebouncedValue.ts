import { useEffect, useState } from 'react';

/**
 * Debounce a fast-changing value (search input) before it reaches a query key,
 * so typing doesn't fire one request per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
