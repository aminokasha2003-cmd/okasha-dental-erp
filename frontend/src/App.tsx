import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { useI18n } from "./i18n";
import { Layout } from "./components/Layout";
import { Audit } from "./pages/Audit";
import { NoAccess } from "./pages/ComingSoon";
import { Billing } from "./pages/Billing";
import { Crm } from "./pages/Crm";
import { FeedbackPublic } from "./pages/FeedbackPublic";
import { Reports } from "./pages/Reports";
import { Lab } from "./pages/Lab";
import { Inventory } from "./pages/Inventory";
import { Payroll } from "./pages/Payroll";
import { MyWork } from "./pages/MyWork";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Appointments } from "./pages/Appointments";
import { Clinical } from "./pages/Clinical";
import { PatientProfile } from "./pages/PatientProfile";
import { Patients } from "./pages/Patients";
import { Procedures } from "./pages/Procedures";
import { Settings } from "./pages/Settings";
import { Staff } from "./pages/Staff";
import { Users } from "./pages/Users";
import { Compliance } from "./pages/Compliance";
import { EInvoices } from "./pages/EInvoices";
import { OnlineBooking } from "./pages/OnlineBooking";
import { PublicBooking } from "./pages/PublicBooking";

function Guard({ module, children }: { module: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(module) ? <>{children}</> : <NoAccess />;
}

export function App() {
  const { me, loading } = useAuth();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const feedback = pathname.match(/^\/feedback\/([^/]+)\/?$/);
  if (feedback) return <FeedbackPublic token={decodeURIComponent(feedback[1])} />;
  // The public booking page needs no login.
  if (window.location.pathname.startsWith("/book/")) return <PublicBooking />;
  if (loading) return <p className="pad muted">{t("loading")}</p>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="settings" element={<Guard module="settings"><Settings /></Guard>} />
        <Route path="users" element={<Guard module="users"><Users /></Guard>} />
        <Route path="staff" element={<Guard module="masterdata"><Staff /></Guard>} />
        <Route path="procedures" element={<Guard module="masterdata"><Procedures /></Guard>} />
        <Route path="audit" element={<Guard module="audit"><Audit /></Guard>} />
        <Route path="patients" element={<Guard module="patients"><Patients /></Guard>} />
        <Route path="patients/:id" element={<Guard module="patients"><PatientProfile /></Guard>} />
        <Route path="appointments" element={<Guard module="appointments"><Appointments /></Guard>} />
        <Route path="clinical" element={<Guard module="clinical"><Clinical /></Guard>} />
        <Route path="billing" element={<Guard module="billing"><Billing /></Guard>} />
        <Route path="lab" element={<Guard module="lab"><Lab /></Guard>} />
        <Route path="inventory" element={<Guard module="inventory"><Inventory /></Guard>} />
        <Route path="payroll" element={<Guard module="staff"><Payroll /></Guard>} />
        <Route path="crm" element={<Guard module="crm"><Crm /></Guard>} />
        <Route path="reports" element={<Guard module="reports"><Reports /></Guard>} />
        <Route path="reports/:key" element={<Guard module="reports"><Reports /></Guard>} />
        <Route path="compliance" element={<Guard module="compliance"><Compliance /></Guard>} />
        <Route path="einvoices" element={<Guard module="einvoice"><EInvoices /></Guard>} />
        <Route path="online-booking" element={<Guard module="appointments"><OnlineBooking /></Guard>} />
        <Route path="my-work" element={<MyWork />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
