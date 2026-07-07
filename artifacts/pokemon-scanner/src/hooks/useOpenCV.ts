import { useState, useEffect, useRef } from 'react';

declare global {
  interface Window {
    cv: any;
    Module: any;
  }
}

export function useOpenCV() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const scriptInjected = useRef(false);

  useEffect(() => {
    if (window.cv && typeof window.cv.getBuildInformation === 'function') {
      setLoaded(true);
      return;
    }

    if (scriptInjected.current) return;
    scriptInjected.current = true;

    // Check if script already exists from previous HMR
    if (document.querySelector('script[src="https://docs.opencv.org/4.8.0/opencv.js"]')) {
      const interval = setInterval(() => {
        if (window.cv && typeof window.cv.getBuildInformation === 'function') {
          clearInterval(interval);
          setLoaded(true);
        }
      }, 100);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.async = true;
    script.onload = () => {
      const interval = setInterval(() => {
        if (window.cv && typeof window.cv.getBuildInformation === 'function') {
          clearInterval(interval);
          setLoaded(true);
        }
      }, 100);
    };
    script.onerror = () => {
      setError(true);
    };
    document.body.appendChild(script);
  }, []);

  return { loaded, error };
}
