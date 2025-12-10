import "../styles/Sidebar.css";

type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

export default function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <div className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-content">
        <div className="sidebar-content-tittle">
            <h3>Menú</h3>
            <button className="close-btn" onClick={onClose}>
            ✕
            </button>
        </div>
        
      </div>
    </div>
  );
}
