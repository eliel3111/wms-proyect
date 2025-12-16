import { useAuth } from "../context/AuthProvider";
import { useEffect, useState } from "react";
import "../styles/Header.css";
import { useNavigate } from "react-router-dom";

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

  const navigate = useNavigate();

    function goToMenu() {
      navigate("/menu");
    };

  return (
    <header className={`app-header ${hidden ? "hidden" : ""}`}>
      {/* Div A: LOGO */}
      <div className="header-left" onClick={goToMenu} >
        <svg className="menu-icon-svg"  enable-background="new 0 0 24 24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" id="fi_3603178"><path d="m5 0h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m5 9h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m5 18h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m14 0h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m14 9h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m14 18h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m23 0h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m23 9h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m23 18h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path></svg>
      </div>

      <div className="header-container-right">
            {/* Div B: Usuario + Logout (solo desktop/tablet) */}
      <div className="header-center">
        {user && <span className="header-username">{user.full_name}</span>}
      </div>

      {/* Div C: Menú móvil */}
      <div className="header-right">
        <button className="menu-btn" onClick={onMenuClick}>
          <svg height={25}  viewBox="0 -53 384 384"  xmlns="http://www.w3.org/2000/svg" id="fi_1828551"><path d="m368 154.667969h-352c-8.832031 0-16-7.167969-16-16s7.167969-16 16-16h352c8.832031 0 16 7.167969 16 16s-7.167969 16-16 16zm0 0"></path><path d="m368 32h-352c-8.832031 0-16-7.167969-16-16s7.167969-16 16-16h352c8.832031 0 16 7.167969 16 16s-7.167969 16-16 16zm0 0"></path><path d="m368 277.332031h-352c-8.832031 0-16-7.167969-16-16s7.167969-16 16-16h352c8.832031 0 16 7.167969 16 16s-7.167969 16-16 16zm0 0"></path></svg>
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
