// src/layouts/MainLayout.jsx
import { useState } from "react";
import Header from "./Header";
import Sidebar from "./Sidebar";
import "../styles/MainLayout.css";
import { Outlet } from "react-router-dom"; 

export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function openSidebar() {
    setSidebarOpen(true);
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  return (
    <div className="layout-container">
      <Header 
        logo="/logo.png"
        onMenuClick={openSidebar}
      />

      {/* Overlay para cerrar sidebar */}
      {sidebarOpen && (
        <div className="overlay" onClick={closeSidebar}></div>
      )}

      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      <main className="layout-content">
        <Outlet />
      </main>
    </div>
  );
}
