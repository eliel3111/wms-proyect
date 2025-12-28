import "../styles/LoadingScreen.css"

export function LoadingScreen({ text = "Cargando..." }: { text?: string }) {
    return (
        <div className="loading-container">
            <div className="loading-card">
                <div className="spinner" />
                <div className="loading-text">{text}</div>
            </div>
        </div>
    );
}
