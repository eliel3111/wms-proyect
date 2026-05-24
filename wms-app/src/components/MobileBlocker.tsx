const MobileBlocker = ({ isMobile }) => {
  if (!isMobile) return null;

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <h1 style={styles.title}>Módulo no disponible</h1>
        <p style={styles.text}>
          Este módulo solo puede utilizarse desde una computadora.
        </p>
      </div>
    </div>
  );
};

const styles = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "100vh",
    background: "linear-gradient(135deg, #0f172a, #1e293b)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  card: {
    background: "#ffffff",
    padding: "30px 40px",
    borderRadius: "16px",
    textAlign: "center",
    boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
    maxWidth: "320px",
  },
  title: {
    marginBottom: "10px",
    fontSize: "22px",
    color: "#0f172a",
  },
  text: {
    fontSize: "14px",
    color: "#475569",
  },
};

export default MobileBlocker;