import { useNavigate } from "react-router-dom";
import "../styles/MenuButton.css";

type MenuButtonProps = {
  title: string;
  icon: React.ReactNode;
  route: string;              // 👈 nueva prop
  onClick?: () => void;        // 👈 opcional
};

export default function MenuButton({
  title,
  icon,
  route,
  onClick,
}: MenuButtonProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (onClick) {
      onClick();
    }

    if (route) {
      navigate(route);
    }
  };

  return (
  <div
    className="menu-button"
    onClick={handleClick}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        handleClick();
      }
    }}
  >
    <div className="menu-button__icon-card">
      <div className="menu-button__icon">{icon}</div>
    </div>

    <div className="menu-button__title">{title}</div>
  </div>
);
}
