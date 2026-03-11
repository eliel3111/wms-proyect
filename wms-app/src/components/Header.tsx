import { useAuth } from "../context/AuthProvider";
import { useEffect, useState } from "react";
import "../styles/Header.css";
import { useNavigate } from "react-router-dom";


type HeaderProps = {
  onMenuClick: () => void;
};

export default function Header({ onMenuClick }: HeaderProps) {
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
        <svg className="menu-icon-svg"  enableBackground="new 0 0 24 24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" id="fi_3603178"><path d="m5 0h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m5 9h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m5 18h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m14 0h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m14 9h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m14 18h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m23 0h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m23 9h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path><path d="m23 18h-4c-.552 0-1 .448-1 1v4c0 .552.448 1 1 1h4c.552 0 1-.448 1-1v-4c0-.552-.448-1-1-1z"></path></svg>
      </div>

      <div className="header-container-right">
            {/* Div B: Usuario + Logout (solo desktop/tablet) */}
      <div className="header-center">
        {user && <span className="header-username">{user.full_name}</span>}
      </div>

      {/* Div C: Menú móvil */}
      <div className="header-right">
        <button className="menu-btn" onClick={onMenuClick}>
          <svg fill="none" height="25" viewBox="0 0 24 24" width="25" xmlns="http://www.w3.org/2000/svg" id="fi_9650503"><g fill="rgb(0,0,0)"><path d="m5 7c0-2.76142 2.23858-5 5-5 2.7614 0 5 2.23858 5 5s-2.2386 5-5 5c-2.76142 0-5-2.23858-5-5z"></path><path d="m2 21c0-4.4183 3.58172-8 8-8 4.4183 0 8 3.5817 8 8 0 .5523-.4477 1-1 1h-14c-.55228 0-1-.4477-1-1z"></path><path d="m19 2c-.5523 0-1 .44772-1 1s.4477 1 1 1h2c.5523 0 1-.44772 1-1s-.4477-1-1-1z"></path><path d="m16 7c0-.55228.4477-1 1-1h4c.5523 0 1 .44772 1 1s-.4477 1-1 1h-4c-.5523 0-1-.44772-1-1z"></path><path d="m20 10c-.5523 0-1 .4477-1 1s.4477 1 1 1h1c.5523 0 1-.4477 1-1s-.4477-1-1-1z"></path></g></svg>
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
