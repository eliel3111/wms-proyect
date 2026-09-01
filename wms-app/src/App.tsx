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
import PickingValidation from "./pages/picking_user_validation.tsx";
import PickingFinal from "./pages/picking_user_final.tsx"
import BarcodePage from "./pages/Barcode-main.tsx";
import MonitorInventory from "./pages/Inventory_monitor.tsx"
import Inventory_count from "./pages/Inventory_count.tsx"



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
          <Route
            path="ordencompra"
            element={<OrdenCompra />}
          />
          <Route
            path="validation"
            element={<ReceivingValidation />}
          />
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
          <Route path="/picking/validation/:id" element={<PickingValidation />} />
          <Route path="/picking/final/:id" element={<PickingFinal />} />

          {/*BARCODE */}
          <Route path="/barcode-scanner" element={<BarcodePage />} />

          {/*INVENTORY */}
          <Route path="/inventory-monitor" element={<MonitorInventory />} />
          <Route path="/inventory-count" element={<Inventory_count />} />

        </Route>


      </Routes>
    </>
  );
}

export default App;
