import React, { useEffect, useState } from 'react';

function defaultFormatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface CountdownTextProps {
  targetMs: number;
  intervalMs?: number;
  urgentThresholdMs?: number;
  prefix?: string;
  completedText?: string;
  formatFn?: (remainingMs: number) => string;
  className?: string;
  urgentClassName?: string;
  completedClassName?: string;
}

/**
 * Isolated countdown timer cell so parent views do not re-render every tick.
 */
export const CountdownText: React.FC<CountdownTextProps> = React.memo(
  ({
    targetMs,
    intervalMs = 500,
    urgentThresholdMs = 30000,
    prefix = '',
    completedText = '00:00:00',
    formatFn = defaultFormatDuration,
    className = 'text-sky-400',
    urgentClassName = 'text-amber-400 animate-pulse motion-reduce:animate-none',
    completedClassName = 'text-slate-500',
  }) => {
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
      setNowMs(Date.now());
      if (targetMs <= Date.now()) return;

      const timer = setInterval(() => {
        const current = Date.now();
        setNowMs(current);
        if (current >= targetMs) {
          clearInterval(timer);
        }
      }, intervalMs);

      return () => clearInterval(timer);
    }, [targetMs, intervalMs]);

    const remainingMs = targetMs - nowMs;

    if (remainingMs <= 0) {
      return (
        <span className={`font-mono tabular-nums ${completedClassName}`}>
          {prefix}
          {completedText}
        </span>
      );
    }

    const isUrgent = urgentThresholdMs > 0 && remainingMs <= urgentThresholdMs;

    return (
      <span className={`font-mono tabular-nums ${isUrgent ? urgentClassName : className}`}>
        {prefix}
        {formatFn(remainingMs)}
      </span>
    );
  }
);

CountdownText.displayName = 'CountdownText';
