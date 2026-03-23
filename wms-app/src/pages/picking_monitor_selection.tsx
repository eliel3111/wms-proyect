import { useEffect, useState } from "react";
import "../styles/picking.css";
import { Package, Activity } from "lucide-react";
import PickingProcess from "../components/PickingProcess.tsx"
import PickingActive from "../components/PickingActive.tsx"

export default function MonitorPicking() {
    const [isMobile, setIsMobile] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [view, setView] = useState("pickers-active");




    useEffect(() => {
        const mq = window.matchMedia("(max-width: 768px)");

        const apply = () => {
            setIsMobile(mq.matches);
            console.log(isMobile);
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

    return (
        <div className="appShell">
            {/* Desktop sidebar */}
            <aside className="sidebar sidebarDesktop" aria-label="Sidebar desktop">
                <div className="sidebarInner">
                    <h3>Sidebar</h3>
                    <nav className="nav">
                        <button onClick={() => setView("pickers-active")} className="sidebar-button">
                            <Package size={22} />
                            <span>Pickets</span>
                        </button>
                        <button onClick={() => setView("picking-process")} className="sidebar-button">
                            <Activity size={22} />
                            <span>Proceso de Picking</span>
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
                {view === "pickers-active" && <PickingActive />}
                {view === "picking-process" && <PickingProcess />}

            </main>
        </div>
    );
}
