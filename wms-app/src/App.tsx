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
import PutawayMenu from "./pages/PutawayMenu";
import PutawayPick from "./pages/PutawayPick";
import PutawayDrop from "./pages/PutawayDrop";

import { ModalProvider } from "./context/ModalContext";



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
              <ModalProvider>
                <MainLayout />
              </ModalProvider>
            </PrivateRoute>
          }
        >
          <Route path="/menu" element={<Menu />} />

          {/* RECEIVING */}
          <Route path="/receiving" element={<ReceivingSearch />} />
          <Route path="/ordencompra/:id" element={<OrdenCompra />} />
          <Route path="/validation/:id" element={<ReceivingValidation />} />
          <Route path="/final/:id" element={<ReceivingFinal />} />

          {/* PUTAWAY */}
          <Route path="/putaway" element={<PutawayMenu />} />
          <Route path="/putaway/pick" element={<PutawayPick />} />
          <Route path="/putaway/drop" element={<PutawayDrop />} />
        </Route>


      </Routes>
    </>
  );
}

export default App;
