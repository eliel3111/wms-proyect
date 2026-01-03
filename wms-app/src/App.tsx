import { Routes, Route, Link } from "react-router-dom";
import Home from "./pages/home.tsx";
import LoginPage from "./pages/login.tsx";
import MainLayout from "./components/MainLayout";
import PrivateRoute from "./components/PrivateRoute.tsx";
import Menu from "./pages/Menu.tsx";
import ReceivingSearch from "./pages/ReceivingSearch.tsx";
import OrdenCompra from "./pages/OrdenCompra.tsx";
import ReceivingValidation from "./pages/ReceivingValidation.tsx";
import ReceivingFinal from "./pages/ReceivingFinal.tsx";


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
          <Route path="/menu" element={<Menu />} />
          <Route path="/receiving" element={<ReceivingSearch />} />
          <Route path="/ordencompra/:id" element={<OrdenCompra />} />
          <Route path="/validation/:id" element={<ReceivingValidation />} />
          <Route path="/final/:id" element={<ReceivingFinal />} />


      </Route>

        
      </Routes>
    </>
  );
}

export default App;
