import {
  Routes,
  Route,
  Navigate
} from "react-router-dom";

import LoginPage from "./pages/login.tsx";
import MainLayout from "./components/MainLayout";
import PrivateRoute from "./components/PrivateRoute.tsx";
import Menu from "./pages/Menu.tsx";

import ReceivingSearch from "./pages/ReceivingSearch.tsx";
import OrdenCompra from "./pages/OrdenCompra.tsx";
import ReceivingValidation from "./pages/ReceivingValidation.tsx";
import ReceivingFinal from "./pages/ReceivingFinal.tsx";
import ReceivingDetailsPage from "./pages/ReceivingDetailsPage.tsx";

import PutawayMenu from "./pages/PutawayMenu";
import PutawayPick from "./pages/PutawayPick";
import PutawayDrop from "./pages/PutawayDrop";

import TransferWarehouse from "./pages/transferWarehouses.tsx";
import TransferPrincipal from "./pages/TransferPrincipal.tsx";
import TransferPick from "./pages/TransferPick.tsx";
import TransferDrop from "./pages/TransferDrop.tsx";

import ReceiveWareTransferSearch from "./pages/receive_warehouse_transfer.tsx";
import ReceiveWareTransferStart from "./pages/receive_warehouse_reception.tsx";
import ReceiveWareValidation from "./pages/receive_warehouse_validation.tsx";
import ReceiveWareFinal from "./pages/receive_warehouse_final.tsx";

import MonitorPicking from "./pages/picking_monitor_selection.tsx";
import GetAssignedPickings from "./pages/Picking_pending_assigned.tsx";
import PickingRoute from "./pages/Picking_user_working.tsx";
import PickingValidation from "./pages/picking_user_validation.tsx";
import PickingFinal from "./pages/picking_user_final.tsx";

import BarcodePage from "./pages/Barcode-main.tsx";

import MonitorInventory from "./pages/Inventory_monitor.tsx";
import Inventory_count from "./pages/Inventory_count.tsx";

import InspectionPage from "./pages/InspectionPage.tsx";

import InspectionDocumentPage from "./pages/InspectionDocumentPage.tsx";
import ReturnsPage from "./pages/ReturnsPage.tsx";
import ReturnDocumentPage from "./pages/ReturnDocumentPage.tsx";

import {
  ModalProvider
} from "./context/ModalContext";


function App() {

  return (

    <>

      <Routes>


        {/* =====================================================
            PUBLIC
        ===================================================== */}

        <Route
          path="/"
          element={
            <Navigate
              to="/login"
              replace
            />
          }
        />


        <Route
          path="/login"
          element={
            <LoginPage />
          }
        />


        {/* =====================================================
            PRIVATE ROUTES
        ===================================================== */}

        <Route

          element={

            <PrivateRoute>

              <ModalProvider>

                <MainLayout />

              </ModalProvider>

            </PrivateRoute>

          }

        >


          {/* =================================================
              MENU
          ================================================= */}

          <Route
            path="/menu"
            element={
              <Menu />
            }
          />


          {/* =================================================
              RECEIVING
          ================================================= */}

          <Route
            path="/receiving"
            element={
              <ReceivingSearch />
            }
          />


          <Route
            path="/ordencompra"
            element={
              <OrdenCompra />
            }
          />


          <Route
            path="/validation"
            element={
              <ReceivingValidation />
            }
          />


          <Route
            path="/receiving/final"
            element={
              <ReceivingFinal />
            }
          />


          <Route
            path="/receiving/details/:id"
            element={
              <ReceivingDetailsPage />
            }
          />


          <Route
            path="/inspection/:tipo/:erpId"
            element={
              <InspectionDocumentPage />
            }
          />


          {/* =================================================
              PUTAWAY
          ================================================= */}

          <Route
            path="/putaway"
            element={
              <PutawayMenu />
            }
          />


          <Route
            path="/putaway/pick"
            element={
              <PutawayPick />
            }
          />


          <Route
            path="/putaway/drop"
            element={
              <PutawayDrop />
            }
          />


          {/* =================================================
              TRANSFER
          ================================================= */}

          <Route
            path="/transfer"
            element={
              <TransferPrincipal />
            }
          />


          <Route
            path="/transfer/pick"
            element={
              <TransferPick />
            }
          />


          <Route
            path="/transfer/drop"
            element={
              <TransferDrop />
            }
          />


          {/* =================================================
              WAREHOUSE TRANSFER
          ================================================= */}

          <Route
            path="/warehouse-transfer"
            element={
              <TransferWarehouse />
            }
          />


          <Route
            path="/warehouse-transfer-receive"
            element={
              <ReceiveWareTransferSearch />
            }
          />


          <Route
            path="/warehouse-transfer-recepcion/:id"
            element={
              <ReceiveWareTransferStart />
            }
          />


          <Route
            path="/warehouse-transfer-validation/:id"
            element={
              <ReceiveWareValidation />
            }
          />


          <Route
            path="/warehouse-transfer-final/:id"
            element={
              <ReceiveWareFinal />
            }
          />


          {/* =================================================
              WAREHOUSE PICKING
          ================================================= */}

          <Route
            path="/picking-monitor"
            element={
              <MonitorPicking />
            }
          />


          <Route
            path="/picking-user-init"
            element={
              <GetAssignedPickings />
            }
          />


          <Route
            path="/picking/:id"
            element={
              <PickingRoute />
            }
          />


          <Route
            path="/picking/validation/:id"
            element={
              <PickingValidation />
            }
          />


          <Route
            path="/picking/final/:id"
            element={
              <PickingFinal />
            }
          />


          {/* =================================================
              BARCODE
          ================================================= */}

          <Route
            path="/barcode-scanner"
            element={
              <BarcodePage />
            }
          />


          {/* =================================================
              INVENTORY
          ================================================= */}

          <Route
            path="/inventory-monitor"
            element={
              <MonitorInventory />
            }
          />


          <Route
            path="/inventory-count"
            element={
              <Inventory_count />
            }
          />


          {/* =================================================
              INSPECTION
          ================================================= */}

          <Route
            path="/inspection"
            element={
              <InspectionPage />
            }
          />


          <Route path="/returns" element={<ReturnsPage />} />


          <Route
            path="/returns/:tipo/:erpId"
            element={<ReturnDocumentPage />}
          />


        </Route>


      </Routes>

    </>

  );

}


export default App;