import { useEffect, useState } from "react";
import "../styles/picking.css";
import "../styles/InventoryMonitor.css"
import InventoryLive from "../components/InventoryLive.tsx";
import InventorySession from "../components/InventorySession.tsx"
import MobileBlocker from "../components/MobileBlocker.tsx";
import { BarChart3, Clipboard } from "lucide-react";

export default function MonitorInventory() {
    const [isMobile, setIsMobile] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [view, setView] = useState("inventory-session");




    useEffect(() => {
        const mq = window.matchMedia("(max-width: 768px)");

        const apply = () => {
            setIsMobile(mq.matches);
            console.log("USANDO CELULAR", isMobile);
            console.log("USANDO CELULAR", mq.matches);
            // Si vuelve a desktop, cerramos el menú móvil
            if (!mq.matches) setMobileMenuOpen(false);
        };

        apply();

        // Compatibilidad con navegadores
        if (mq.addEventListener) mq.addEventListener("change", apply);
        else mq.addListener(apply);

        return () => {
            if (mq.removeEventListener) mq.removeEventListener("change", apply);
            else mq.removeListener(apply);
        };
    }, []);

    const closeMobileMenu = () => setMobileMenuOpen(false);

    if (isMobile) {
        return <MobileBlocker isMobile={isMobile} />;
    }


    return (
        <div className="appShell">
            {/* Desktop sidebar */}
            <aside className="sidebar sidebarDesktop" aria-label="Sidebar desktop">
                <div className="sidebarInner">
                    <div className="inventory-card">
                        <div className="inventory-icon">
                            <svg
                                width="50"
                                height="50"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#333333"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                {/* Caja estilo isométrico */}
                                <path d="M3 7l9-4 9 4-9 4-9-4z" />
                                <path d="M3 7v10l9 4 9-4V7" />
                                <path d="M12 11v10" />
                            </svg>
                        </div>

                        <h2 className="inventory-title">Inventario</h2>
                        <p className="inventory-subtitle">Gestión de inventario</p>
                    </div>
                    <nav className="nav">



                        <button
                            onClick={() => setView("inventory-session")}
                            className="sidebar-button"
                        >
                            <BarChart3 size={22} color="red" />
                            <span>Método Inventario</span>
                        </button>

                        <button
                            onClick={() => setView("inventory-posted")}
                            className="sidebar-button"
                        >
                            <Clipboard size={22} />
                            <span>Reporte en Vivo</span>
                        </button>
                    </nav>
                </div>
            </aside>

            {/* Mobile header */}
            <header className="mobileHeader" aria-label="Header móvil">
                <button
                    className="mobileToggle"
                    type="button"
                    aria-label="Abrir menú"
                    aria-expanded={mobileMenuOpen}
                    onClick={() => setMobileMenuOpen((v) => !v)}
                >
                    V
                </button>
                <div className="mobileTitle">Mi App</div>
            </header>

            {/* Mobile drawer sidebar */}
            <div
                className={`backdrop ${mobileMenuOpen ? "show" : ""}`}
                onClick={closeMobileMenu}
                aria-hidden={!mobileMenuOpen}
            />

            <aside
                className={`sidebar sidebarMobileDrawer ${mobileMenuOpen ? "open" : ""
                    }`}
                aria-label="Sidebar móvil"
            >
                <div className="sidebarInner">
                    <div className="drawerTop">
                        <strong>Menú</strong>
                        <button className="closeBtn" onClick={closeMobileMenu} type="button">
                            ✕
                        </button>
                    </div>

                    <nav className="nav">
                        <a onClick={closeMobileMenu} href="#a">
                            Dashboard
                        </a>
                        <a onClick={closeMobileMenu} href="#b">
                            Orders
                        </a>
                        <a onClick={closeMobileMenu} href="#c">
                            Settings
                        </a>
                    </nav>
                </div>
            </aside>

            {/* Main content */}
            <main className="main" aria-label="Contenido principal">
                {view === "inventory-session" && <InventorySession />}
                {view === "inventory-posted" && <InventoryLive />}

            </main>
        </div>
    );
}
