import "../styles/SyncERPFullScreen.css";

export function SyncERPFullScreen({
  text = "Sincronizando existencia de todos los productos desde Citrus.",
  subtext = "Esto puede tomar unos minutos.",
}: {
  text?: string;
  subtext?: string;
}) {
  return (
    <div className="sync-erp-fullscreen">
      <div className="sync-erp-content">
        <div className="sync-erp-spinner" />

        <div className="sync-erp-title">
          {text}
        </div>

        <div className="sync-erp-subtitle">
          {subtext}
        </div>
      </div>
    </div>
  );
}