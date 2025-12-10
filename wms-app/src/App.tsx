import { Routes, Route, Link } from "react-router-dom";
import Home from "./pages/home.tsx";
import LoginPage from "./pages/login.tsx";
import MainLayout from "./components/MainLayout";
import PrivateRoute from "./components/PrivateRoute.tsx";
import Dashboard from "./pages/Dashboard";

function App() {
  return (
     <>

      {/* RUTAS */}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<LoginPage />} />

        {/* Ruta protegida */}
        <Route 
        element={
          <PrivateRoute>
            <MainLayout />
          </PrivateRoute>
        }
      >
          <Route path="/dashboard" element={<Dashboard />} />

      </Route>

        
      </Routes>
    </>
  );
}

export default App;
