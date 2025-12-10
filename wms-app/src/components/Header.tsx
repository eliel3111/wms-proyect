import { useAuth } from "../context/AuthProvider";
import { useEffect, useState } from "react";
import "../styles/Header.css";

export default function Header({ logo, onMenuClick }) {
  const { user, logout } = useAuth();
  const [hidden, setHidden] = useState(false);
  let lastScroll = 0;

  useEffect(() => {
    function handleScroll() {
      const current = window.scrollY;

      if (current > lastScroll && current > 60) {
        setHidden(true);     // scroll down → esconder
      } else {
        setHidden(false);    // scroll up → mostrar
      }

      lastScroll = current;
    }

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header className={`app-header ${hidden ? "hidden" : ""}`}>
      {/* Div A: LOGO */}
      <div className="header-left">
        <img src={logo} alt="Logo" className="header-logo" />
      </div>

      <div className="header-container-right">
            {/* Div B: Usuario + Logout (solo desktop/tablet) */}
      <div className="header-center">
        {user && <span className="header-username">{user.full_name}</span>}
      </div>

      {/* Div C: Menú móvil */}
      <div className="header-right">
        <button className="menu-btn" onClick={onMenuClick}>
          ☰
        </button>

        {user && (
          <button className="logout-btn" onClick={logout}>
            Logout
          </button>
        )}
      </div>
      </div>

      
    </header>
  );
}
