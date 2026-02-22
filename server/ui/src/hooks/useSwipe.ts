import { useRef, useCallback } from "react";

interface UseSwipeOptions {
  threshold?: number;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onProgress?: (dx: number) => void;
  onCancel?: () => void;
}

export function useSwipe({
  threshold = 80,
  onSwipeLeft,
  onSwipeRight,
  onProgress,
  onCancel,
}: UseSwipeOptions) {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const intentDetermined = useRef(false);
  const isHorizontal = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    intentDetermined.current = false;
    isHorizontal.current = false;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (startX.current === null || startY.current === null) return;
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current;

    if (!intentDetermined.current) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      intentDetermined.current = true;
      isHorizontal.current = Math.abs(dx) > Math.abs(dy);
    }

    if (!isHorizontal.current) return;

    e.preventDefault();
    onProgress?.(dx);
  }, [onProgress]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (startX.current === null || !isHorizontal.current) {
      onCancel?.();
      startX.current = null;
      startY.current = null;
      return;
    }

    const dx = e.changedTouches[0].clientX - startX.current;
    startX.current = null;
    startY.current = null;

    if (dx > threshold) {
      onSwipeRight?.();
    } else if (dx < -threshold) {
      onSwipeLeft?.();
    } else {
      onCancel?.();
    }
  }, [threshold, onSwipeLeft, onSwipeRight, onCancel]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
