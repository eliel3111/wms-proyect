import "../styles/Sidebar.css";
import { useAuth } from "../context/AuthProvider";

type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const handleLogout = () => {
    logout();
  };

  return (
    <div className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-content">
        <div className="sidebar-content-tittle">
          <h3>Menú</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="sidebar-option ">
          <span className="label">{user?.full_name}</span>
        </div>



        <div onClick={handleLogout} role="button" className="sidebar-option logout">
          <span className="icon">
            <svg
              viewBox="0 0 12 12"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <g fill="currentColor">
                <path d="m8.5 11.125h-6c-.3447266 0-.625-.2802734-.625-.625v-9c0-.3447266.2802734-.625.625-.625h6c.2070313 0 .375-.1679688.375-.375s-.1679687-.375-.375-.375h-6c-.7578125 0-1.375.6166992-1.375 1.375v9c0 .7583008.6171875 1.375 1.375 1.375h6c.2070313 0 .375-.1679688.375-.375s-.1679687-.375-.375-.375z"></path>
                <path d="m10.765625 5.7348633-2.5-2.5c-.1464844-.1464844-.3847656-.1464844-.53125 0-.1455078.1464844-.1455078.3837891 0 .5302734l1.8602905 1.8598633h-5.0946655c-.2070312 0-.375.1679688-.375.375s.1679688.375.375.375h5.0946655l-1.8602905 1.8598633c-.1455078.1464844-.1455078.3837891 0 .5302734.0732422.0732422.1699219.1098633.265625.1098633s.1923828-.0366211.265625-.1098633l2.5-2.5c.1455078-.1464844.1455078-.383789 0-.5302734z"></path>
              </g>
            </svg>
          </span>

          <span className="label">Cerrar sesión</span>
        </div>

      </div>
    </div>
  );
}
