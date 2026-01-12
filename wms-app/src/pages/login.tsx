import LoginForm from "../components/LoginForm";
import menuImagen from "../assets/menu-logo.png"

export default function LoginPage() {
  return (
    <div className="login-page">
      <div className="menu-image-container">
        <img 
          src={menuImagen}
          alt="Menu"
          className="menu-image"
        />
      </div>
      <LoginForm />
    </div>
  );
}
