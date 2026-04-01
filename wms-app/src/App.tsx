import { Routes, Route } from "react-router-dom";
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
import TransferWarehouse from "./pages/transferWarehouses.tsx"
import { ModalProvider } from "./context/ModalContext";
import TransferPrincipal from "./pages/TransferPrincipal.tsx";
import TransferPick from "./pages/TransferPick.tsx"
import TransferDrop from "./pages/TransferDrop.tsx"
import ReceiveWareTransferSearch from "./pages/receive_warehouse_transfer.tsx"
import ReceiveWareTransferStart from "./pages/receive_warehouse_reception.tsx"
import ReceiveWareValidation from "./pages/receive_warehouse_validation.tsx"
import ReceiveWareFinal from "./pages/receive_warehouse_final.tsx"
import MonitorPicking from "./pages/picking_monitor_selection.tsx";
import GetAssignedPickings from "./pages/Picking_pending_assigned.tsx";
import PickingRoute from "./pages/Picking_user_working.tsx"



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


          {/* RECEIVING */}
          <Route path="menu" element={<Menu />} />
          <Route path="receiving" element={<ReceivingSearch />} />
          <Route path="ordencompra/:id" element={<OrdenCompra />} />
          <Route path="validation/:id" element={<ReceivingValidation />} />
          <Route path="receiving/final/:id" element={<ReceivingFinal />} />


          {/* PUTAWAY */}
          <Route path="/putaway" element={<PutawayMenu />} />
          <Route path="/putaway/pick" element={<PutawayPick />} />
          <Route path="/putaway/drop" element={<PutawayDrop />} />

          {/* TRANSFER */}
          <Route path="/transfer" element={<TransferPrincipal />} />
          <Route path="/transfer/pick" element={<TransferPick />} />
          <Route path="/transfer/drop" element={<TransferDrop />} />

          {/*WAREHOUSE TRANSFER */}
          <Route path="/warehouse-transfer" element={<TransferWarehouse />} />
          <Route path="/warehouse-transfer-receive" element={<ReceiveWareTransferSearch />} />
          <Route path="/warehouse-transfer-recepcion/:id" element={<ReceiveWareTransferStart />} />
          <Route path="/warehouse-transfer-validation/:id" element={<ReceiveWareValidation />} />
          <Route path="/warehouse-transfer-final/:id" element={<ReceiveWareFinal />} />

          {/*WAREHOUSE PICKING */}
          <Route path="/picking-monitor" element={<MonitorPicking />} />
          <Route path="/picking-user-init" element={<GetAssignedPickings />} />
          <Route path="/picking/:id" element={<PickingRoute />} />

        </Route>


      </Routes>
    </>
  );
}

export default App;
