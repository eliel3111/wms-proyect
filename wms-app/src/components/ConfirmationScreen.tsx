import { useEffect } from "react";
import "./ConfirmationScreen.css";

type ConfirmationScreenProps = {
  title?: string;
  message: string;
  autoCloseMs?: number;
  onFinish?: () => void;
};

export default function ConfirmationScreen({
  title = "Proceso completado",
  message,
  autoCloseMs,
  onFinish,
}: ConfirmationScreenProps) {

  useEffect(() => {
    if (!autoCloseMs || !onFinish) return;
    const t = setTimeout(onFinish, autoCloseMs);
    return () => clearTimeout(t);
  }, [autoCloseMs, onFinish]);

  return (
    <div className="confirm-overlay">
      <div className="confirm-container">

        {/* ✅ SVG CHECK */}
        <svg
          className="confirm-icon"
          width="140"
          height="140"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle cx="12" cy="12" r="11" />
          <path d="M7 12.5L10.2 15.5L17 9" />
        </svg>

        <h1 className="confirm-title">{title}</h1>
        <p className="confirm-message">{message}</p>
      </div>
    </div>
  );
}
