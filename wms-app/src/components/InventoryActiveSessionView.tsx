import { useState } from "react";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import type {
  AdjustmentMode,
  InventorySession
} from "./InventorySession.tsx";

import ConfirmationModal from "../components/ConfirmationModal";

import {
  Boxes,
  Tag,
  SlidersHorizontal,
  UserRound,
  CalendarDays,
  Trash2,
  Play,
  RotateCcw,
  CheckCircle2,
  Layers3
} from "lucide-react";

import "../styles/InventoryMonitorOptions.css";


type Props = {

  adjustmentMode:
    AdjustmentMode;

  session:
    InventorySession;

  setHasActiveSession:
    React.Dispatch<
      React.SetStateAction<boolean>
    >;

  setSession:
    React.Dispatch<
      React.SetStateAction<
        InventorySession | null
      >
    >;

};


export default function InventoryActiveSessionView({
  adjustmentMode,
  session,
  setHasActiveSession,
  setSession
}: Props) {


  const { openModal } =
    useModal();


  const [
    showCancelConfirmation,
    setShowCancelConfirmation
  ] = useState(false);


  /* ========================================================
     INICIAR / COMPLETAR / REANUDAR
  ======================================================== */

  const handleStartOrComplete =
    async () => {

      try {

        let endpoint = "";


        // DRAFT → INICIAR

        if (
          session.status ===
          "draft"
        ) {

          endpoint =
            "/inventory/session/start";

        }


        // IN-PROGRESS → FINALIZAR

        else if (
          session.status ===
          "in-progress"
        ) {

          endpoint =
            "/inventory/session/complete";

        }


        // REVIEW → VOLVER A CONTAR

        else if (
          session.status ===
          "review"
        ) {

          endpoint =
            "/inventory/session/resume";

        }


        else {

          openModal({
            title:
              "Estado no válido",

            message:
              `No se puede procesar una sesión con estado ${session.status}.`,
          });


          return;

        }


        const response =
          await apiClient.post(
            endpoint,
            {
              id:
                session.id
            }
          );


        const data =
          response.data;


        if (
          !data.success
        ) {

          openModal({
            title:
              data.title ||
              "Error",

            message:
              data.message ||
              "No se pudo procesar la sesión de inventario.",
          });


          return;

        }


        setHasActiveSession(
          data.hasActiveSession
        );


        setSession(
          data.session
        );


      } catch (error) {

        console.error(
          "❌ Error procesando sesión:",
          error
        );


        openModal({
          title:
            "Error de sesión",

          message:
            "No se pudo procesar la sesión de inventario.",
        });

      }

    };


  /* ========================================================
     CANCELAR SESIÓN
  ======================================================== */

  const handleCancelSession =
    async () => {

      try {

        const response =
          await apiClient.post(
            "/inventory/session/cancel",
            {
              id:
                session.id
            }
          );


        const data =
          response.data;


        if (
          !data.success
        ) {

          openModal({
            title:
              data.title,

            message:
              data.message,
          });


          return;

        }


        setHasActiveSession(
          false
        );


        setSession(
          null
        );


      } catch (error) {

        console.error(
          "❌ Error cancelando sesión:",
          error
        );


        openModal({
          title:
            "Error cancelando sesión",

          message:
            "No se pudo cancelar la sesión de inventario.",
        });

      }

    };


  /* ========================================================
     FINALIZAR SESIÓN
  ======================================================== */

  const handleFinalizeSession =
    async () => {

      try {

        console.log(
          "🟩 FINALIZANDO SESIÓN:",
          session.id
        );


        const response =
          await apiClient.post(
            "/inventory/session/finalize",
            {
              id:
                session.id
            }
          );


        const data =
          response.data;


        console.log(
          "📦 RESPUESTA FINALIZE:",
          data
        );


        if (
          !data.success
        ) {

          openModal({

            title:
              data.title ||
              "No se pudo finalizar",

            message:
              data.message ||
              "No se pudo finalizar la sesión de inventario."

          });


          return;

        }


        // ======================================================
        // YA NO EXISTE SESIÓN ACTIVA
        // ======================================================

        setHasActiveSession(
          false
        );


        setSession(
          null
        );


        // ======================================================
        // MENSAJE
        // ======================================================

       
openModal({
  title:
    data.title ||
    "✅ INVENTARIO FINALIZADO",

  message:
    data.message ||
    "La sesión de inventario fue finalizada correctamente.",

  buttonText: "Entendido",
  titleColor: "green"
});



      } catch (error) {

        console.error(
          "❌ ERROR FINALIZANDO SESIÓN:",
          error
        );


        openModal({

          title:
            "Error finalizando inventario",

          message:
            "No se pudo finalizar la sesión de inventario."

        });

      }

    };


  /* ========================================================
     RENDER
  ======================================================== */

  return (

    <div className="inventory-monitor-container-option">


      {/* =====================================================
          PAGE HEADER
      ===================================================== */}

      <div className="inventory-monitor-session-up">

        <div className="inventory-session-page-icon">

          <Boxes
            size={29}
            strokeWidth={2}
          />

        </div>


        <div className="inventory-session-page-heading">

          <span className="inventory-session-eyebrow">
            INVENTARIO
          </span>


          <div className="inventory-session-title">
            Estado de la Sesión
          </div>


          <div className="inventory-session-subtitle">
            Información general del inventario
          </div>

        </div>

      </div>


      {/* =====================================================
          SESSION CARD
      ===================================================== */}

      <div className="inventory-monitor-session-middle">


        {/* CARD TITLE */}

        <div className="inventory-session-card-header">

          <div className="inventory-session-card-header-icon">

            <Layers3
              size={23}
              strokeWidth={2}
            />

          </div>


          <span>
            Sesión Activa
          </span>

        </div>


        {/* SESSION CODE */}

        <div className="inventory-session-code-container">

          <span className="inventory-session-code-line" />


          <div className="inventory-session-code">
            {session.code}
          </div>

        </div>


        {/* =================================================
            INFORMATION GRID
        ================================================= */}

        <div className="inventory-session-info-grid">


          {/* STATUS */}

          <div className="inventory-session-info-card">

            <div className="inventory-session-info-icon">

              <Tag
                size={21}
                strokeWidth={2}
              />

            </div>


            <div className="inventory-session-info-content">

              <div className="inventory-session-label">
                Estado
              </div>


              <div
                className={`
                  inventory-session-status

                  ${
                    session.status ===
                    "draft"

                      ? "draft"

                      : session.status ===
                        "review"

                        ? "review"

                        : "in-progress"
                  }
                `}
              >

                {session.status}

              </div>

            </div>

          </div>


          {/* MODE */}

          <div className="inventory-session-info-card">

            <div className="inventory-session-info-icon">

              <SlidersHorizontal
                size={21}
                strokeWidth={2}
              />

            </div>


            <div className="inventory-session-info-content">

              <div className="inventory-session-label">
                Modo
              </div>


              <div className="inventory-session-info-value">
                {adjustmentMode}
              </div>

            </div>

          </div>


          {/* CREATED BY */}

          <div className="inventory-session-info-card">

            <div className="inventory-session-info-icon">

              <UserRound
                size={21}
                strokeWidth={2}
              />

            </div>


            <div className="inventory-session-info-content">

              <div className="inventory-session-label">
                Creado por
              </div>


              <div className="inventory-session-info-value">

                {
                  session.full_name ||
                  session.name ||
                  "N/A"
                }

              </div>

            </div>

          </div>


          {/* START DATE */}

          <div className="inventory-session-info-card">

            <div className="inventory-session-info-icon">

              <CalendarDays
                size={21}
                strokeWidth={2}
              />

            </div>


            <div className="inventory-session-info-content">

              <div className="inventory-session-label">
                Fecha de inicio
              </div>


              <div
                className="
                  inventory-session-info-value
                  inventory-session-date
                "
              >

                {
                  session.start_date ||
                  "No iniciada"
                }

              </div>

            </div>

          </div>

        </div>


        {/* =================================================
            ACTIONS
        ================================================= */}

        <div className="inventory-monitor-session-down">


          {/* CANCEL */}

          <button
            type="button"

            className="inventory-session-close-btn"

            onClick={() =>
              setShowCancelConfirmation(
                true
              )
            }
          >

            <Trash2
              size={18}
              strokeWidth={2}
            />

            <span>
              Cancelar Sesión
            </span>

          </button>


          {/* MAIN ACTION */}

          <button
            type="button"

            className="inventory-session-action-btn"

            onClick={
              handleStartOrComplete
            }
          >

            {
              session.status ===
              "review"

                ? (
                  <RotateCcw
                    size={18}
                    strokeWidth={2}
                  />
                )

                : (
                  <Play
                    size={18}
                    strokeWidth={2}
                  />
                )
            }


            <span>

              {
                session.status ===
                "draft"

                  ? "Iniciar Sesión"

                  : session.status ===
                    "in-progress"

                    ? "Revisar Sesión"

                    : session.status ===
                      "review"

                      ? "Reanudar Conteo"

                      : "Procesar Sesión"
              }

            </span>

          </button>


          {/* FINALIZE */}

          {
            session.status ===
              "review" &&

            session
              .has_completed_adjustment ===
              true && (

              <button
                type="button"

                className="
                  inventory-session-action-btn
                  green
                "

                onClick={
                  handleFinalizeSession
                }
              >

                <CheckCircle2
                  size={18}
                  strokeWidth={2}
                />

                <span>
                  Finalizar la Sesión
                </span>

              </button>

            )
          }

        </div>

      </div>


      {/* =====================================================
          CONFIRMATION
      ===================================================== */}

      <ConfirmationModal

        isOpen={
          showCancelConfirmation
        }

        title=
          "Cancelar sesión de inventario"

        message=
          "¿Está seguro de que desea cancelar esta sesión de inventario? Esta acción cancelará la sesión actual."

        confirmText=
          "Sí, cancelar sesión"

        cancelText=
          "No, volver"

        onClose={() =>
          setShowCancelConfirmation(
            false
          )
        }

        onConfirm={
          async () => {

            await handleCancelSession();


            setShowCancelConfirmation(
              false
            );

          }
        }

      />

    </div>

  );

}